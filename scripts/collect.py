import json
import os
from datetime import datetime, timezone
from typing import Any
from sources.models_dev import fetch_models_dev_catalog
from sources.llm_stats import fetch_llm_stats, attach_llm_stats, stats_index
from scripts.detect_changes import detect_model_changes
from scripts.notify_telegram import send_telegram, send_alerts

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
MODELS_FILE = os.path.join(DATA_DIR, "models.json")
OFFERS_FILE = os.path.join(DATA_DIR, "offers.json")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
STATS_FILE = os.path.join(DATA_DIR, "llm_stats.json")
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

def _build_offer_map(offers: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Maps every offer's included model IDs to its quota block."""
    omap = {}
    for o in offers:
        for mid in o.get("models_included", []):
            omap[mid] = {k: v for k, v in o.items() if k != "models_included"}
    return omap

def _merge_quota(model: Dict[str, Any], offer_map: Dict[str, Dict[str, Any]]) -> None:
    """Link a provider free tier record onto each matching model row."""
    mid = model.get("model_id", "") or ""
    pid = model.get("provider_id", "") or ""
    key = mid if mid else f"{pid}/{model.get('name', '')}"
    offer = offer_map.get(key)
    if offer is not None:
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

    # 1. Fetch the complete provider and model catalog
    new_models = fetch_models_dev_catalog()
    curated_offers = load_json(OFFERS_FILE, [])

    if not new_models:
        print("[Warn] No models fetched from providers. Keeping old snapshot.")
        new_models = old_models

    # 1b. Optional benchmark enrichment from llm-stats.com, joined by model name
    llm_stats = fetch_llm_stats()
    if llm_stats:
        attach_llm_stats(new_models, llm_stats)
        # Store the score table once; models.json only carries a short pointer id.
        save_json(STATS_FILE, stats_index(llm_stats))

    # 1c. Merge curated free-tier quotas into each free model row so the
    #     dashboard can show how many requests / tokens per minute the user
    #     has left on that model.  Built from the committed offers block.
    offer_map = _build_offer_map(curated_offers)
    for m in new_models:
        _merge_quota(m, offer_map)

    # 2. Diff and detect changes (free transitions first, batched, capped)
    events, alerts = detect_model_changes(old_models, new_models)
    print(f"[Diff] Detected {len(events)} new events and {len(alerts)} alert message(s).")

    # 3. Send Telegram alerts as one capped, rate-limit-safe batch
    send_alerts(alerts)

    # 4. Save snapshots
    updated_history = (events + old_history)[:200]
    save_json(MODELS_FILE, new_models)
    save_json(OFFERS_FILE, curated_offers)
    save_json(HISTORY_FILE, updated_history)

    print(
        f"[Done] Total models tracked: {len(new_models)} "
        f"across {len({m['provider_id'] for m in new_models})} providers"
    )

if __name__ == "__main__":
    main()
