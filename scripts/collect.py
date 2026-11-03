import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List
from sources.free_tiers_upstream import fetch_upstream_free_tiers, PROVIDER_ALIASES
from sources.models_dev import fetch_models_dev_catalog
from sources.litellm import fetch_litellm_catalog, enrich_models
from sources.llm_stats import fetch_llm_stats, attach_llm_stats, stats_index
from sources.aidatahub import fetch_model_releases, build_release_index
from sources.freeinference import fetch_free_inference, merge_offers, unresolved_offers
from scripts.detect_changes import detect_model_changes
from scripts.notify_telegram import send_telegram, send_alerts
from scripts.build_lookup import save_lookup

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
MODELS_FILE = os.path.join(DATA_DIR, "models.json")
OFFERS_FILE = os.path.join(DATA_DIR, "offers.json")
RELEASES_FILE = os.path.join(DATA_DIR, "releases.json")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
# Price moves are the bulk of every run's diff, so at a small cap they push new
# models out of the changelog within hours. Keep the changelog reserved for
# debuts and free transitions, and archive price moves in a separate log.
HISTORY_LIMIT = 2000
PRICE_LOG_FILE = os.path.join(DATA_DIR, "price_log.json")
PRICE_LOG_LIMIT = 5000
STATS_FILE = os.path.join(DATA_DIR, "llm_stats.json")
LOOKUP_FILE = os.path.join(DATA_DIR, "lookup.json")
def load_json(filepath: str, default: Any = None):
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return default if default is not None else []
    return default if default is not None else []

def save_json(filepath: str, data: Any):
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _merge_events(fresh: List[Dict[str, Any]], previous: List[Dict[str, Any]], limit: int) -> List[Dict[str, Any]]:
    """Prepends this run's events, drops ids already on record, caps the list."""
    seen = {e.get("event_id") for e in previous if e.get("event_id")}
    merged: List[Dict[str, Any]] = []
    for event in fresh:
        eid = event.get("event_id")
        if eid and eid in seen:
            continue
        if eid:
            seen.add(eid)
        merged.append(event)
    return (merged + previous)[:limit]

import re


def _norm_id(value: str) -> str:
    """Strips provider prefixes, ':free' variant suffixes and punctuation so ids from either source compare equal."""
    v = str(value or "").lower()
    if "/" in v:
        v = v.rsplit("/", 1)[-1]
    if ":" in v:
        v = v.split(":", 1)[0]
    return re.sub(r"[^a-z0-9]", "", v)


def _has_universal_quota(offer: Dict[str, Any]) -> bool:
    """True when the offer carries a provider-wide quota (not per-model limits)."""
    return any(offer.get(k) for k in ("quota_requests_day", "quota_tokens_minute", "quota_requests_minute")) or bool(offer.get("rolling_window"))


def _build_offer_map(offers: List[Dict[str, Any]]):
    """
    Maps every offer's included model IDs to its quota block.

    Returns (omap, pmap): omap keys are (normalized offer id, normalized model id)
    for per-model quotas; pmap keys are just the normalized provider id and hold
    offers with a provider-wide quota (quota set but no models_included list).

    The offer id is expanded through PROVIDER_ALIASES so a catalog provider like
    'groq' matches upstream's 'groq-cloud'. Model ids normalize away prefixes and
    punctuation so 'qwen/qwen3.8-27b' and 'qwen3-8-27b' collapse together.
    """
    omap = {}
    pmap = {}
    for o in offers:
        block = {k: v for k, v in o.items() if k != "models_included"}
        oid = _norm_id(o.get("id", ""))
        # Register under the upstream id plus every alias that points at it
        provider_keys = {oid}
        for our_pid, upstream_pid in PROVIDER_ALIASES.items():
            if upstream_pid == o.get("id"):
                provider_keys.add(_norm_id(our_pid))
        for pk in provider_keys:
            if _has_universal_quota(o) and pk not in pmap:
                pmap[pk] = block
        for mid in o.get("models_included", []):
            nmid = _norm_id(mid)
            for pk in provider_keys:
                omap[(pk, nmid)] = block
    return omap, pmap


def _merge_quota(model: Dict[str, Any], offer_map, provider_map) -> None:
    """Link a provider free tier record onto each matching model row."""
    mid = _norm_id(model.get("model_id", "") or model.get("name", ""))
    pid = _norm_id(model.get("provider_id", ""))
    offer = offer_map.get((pid, mid))
    if offer is None:
        # Fall back to the provider's universal quota when the model isn't
        # listed individually (e.g. nvidia-nim's 1000 req/day covers all models).
        offer = provider_map.get(pid)
        if offer is None:
            return
    # Per-model rate limits win over the provider's universal quota.
    for pm in offer.get("per_model_rate_limits") or []:
        if _norm_id(pm.get("model_id", "")) == mid:
            merged = dict(offer)
            merged.update({k: v for k, v in pm.items() if k != "model_id"})
            model["offer"] = merged
            return
    model["offer"] = offer

def main():
    print(f"[{datetime.now(timezone.utc).isoformat()}] Starting AI Catalog Sync...")

    # Manual verification path: Actions -> Run workflow -> test_alert
    if os.getenv("TEST_ALERT", "").lower() in ("1", "true", "yes"):
        ok = send_telegram(
            "🛰️ <b>Free AI Radar test alert</b>\n"
            "If you can read this, the GitHub Actions secrets are wired correctly."
        )
        print(f"[Test] Telegram test alert {'SENT' if ok else 'FAILED — check secrets above'}.")
        return

    old_models = load_json(MODELS_FILE, [])
    old_history = load_json(HISTORY_FILE, [])
    old_price_log = load_json(PRICE_LOG_FILE, [])

    # 1. Fetch the complete provider and model catalog
    new_models = fetch_models_dev_catalog()

    # 1a. Fetch upstream free-tier quotas (replaces hand-maintained offers.json).
    #     Falls back to the committed file if upstream is unreachable.
    offers_cache = os.path.join(DATA_DIR, "offers_cache.json")
    upstream_offers = fetch_upstream_free_tiers(offers_cache)
    if upstream_offers:
        curated_offers = upstream_offers
        save_json(OFFERS_FILE, curated_offers)  # overwrite with fresh upstream data
    else:
        curated_offers = load_json(OFFERS_FILE, [])
        print("[Warn] Using committed offers.json fallback.")

    # 1b. Enrich models with LiteLLM data (provider, pricing, capabilities).
    litellm_entries = fetch_litellm_catalog()
    if litellm_entries:
        enrich_models(new_models, litellm_entries)
        print(f"[litellm] Enriched {sum(1 for m in new_models if m.get('litellm'))} models.")
    else:
        print("[Warn] No LiteLLM data fetched — models not enriched.")

    if not new_models:
        print("[Warn] No models fetched from providers. Keeping old snapshot.")
        new_models = old_models

    # 1a-ii. Union the FreeInference directory onto the primary free-tier source.
    #      The primary wins on quota numbers; this only adds providers it lacks.
    fi_offers = fetch_free_inference(os.path.join(DATA_DIR, "freeinference_cache.json"))
    if fi_offers:
        curated_offers = merge_offers(curated_offers, fi_offers)
        dangling = unresolved_offers(curated_offers, [m.get("provider_id", "") for m in new_models])
        if dangling:
            print(f"[Warn] {len(dangling)} merged offer(s) match no catalog provider: "
                  f"{', '.join(dangling[:8])}")
    else:
        print("[Warn] FreeInference directory unavailable; primary source only.")

    # 1b. Optional benchmark enrichment from llm-stats.com, joined by model name
    llm_stats = fetch_llm_stats()
    if llm_stats:
        attach_llm_stats(new_models, llm_stats)
        # Store the score table once; models.json only carries a short pointer id.
        save_json(STATS_FILE, stats_index(llm_stats))

    # 1c. Merge curated free-tier quotas into each free model row so the
    #     dashboard can show how many requests / tokens per minute the user
    #     has left on that model.  Built from the committed offers block.
    offer_map, provider_quota_map = _build_offer_map(curated_offers)
    for m in new_models:
        _merge_quota(m, offer_map, provider_quota_map)

    # 1d. Official release dates from AIDataHub. Joined by name on the frontend;
    #     this only fills the announcement date models.dev leaves blank.
    releases = fetch_model_releases(os.path.join(DATA_DIR, "aidatahub_cache.json"))
    if releases:
        save_json(RELEASES_FILE, build_release_index(releases))
        print(f"[AIDataHub] Recorded {len(releases)} release(s).")
    else:
        print("[Warn] Release feed unavailable; keeping previous data/releases.json.")

    # 2. Diff and detect changes (free transitions first, batched, capped)
    events, alerts = detect_model_changes(old_models, new_models)
    print(f"[Diff] Detected {len(events)} new events and {len(alerts)} alert message(s).")

    # 3. Send Telegram alerts as one capped, rate-limit-safe batch
    send_alerts(alerts)

    # 4. Save snapshots. Price moves go to their own log so they cannot evict
    # new models from the changelog; both lists are de-duplicated by event_id so
    # a re-detected change (same key, same timestamp) is not written twice.
    price_events = [e for e in events if e["type"] == "price_change"]
    story_events = [e for e in events if e["type"] != "price_change"]
    save_json(HISTORY_FILE, _merge_events(story_events, old_history, HISTORY_LIMIT))
    save_json(PRICE_LOG_FILE, _merge_events(price_events, old_price_log, PRICE_LOG_LIMIT))
    save_json(MODELS_FILE, new_models)
    save_json(OFFERS_FILE, curated_offers)
    save_lookup(new_models)

    # 5. Usage rankings for the Boards tab (independent of the catalog diff)
    from scripts.build_leaderboard import main as build_leaderboard
    build_leaderboard()

    print(
        f"[Done] Total models tracked: {len(new_models)} "
        f"across {len({m['provider_id'] for m in new_models})} providers"
    )

if __name__ == "__main__":
    main()
