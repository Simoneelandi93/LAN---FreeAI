"""Fetches the community-maintained AI free-tier quota dataset.

Upstream: 4pixeltechBR/awesome-ai-free-tiers (MIT licensed, 65 providers).
The remote providers.json is a curated, audited directory of free-tier quotas
— far more coverage than a hand-maintained list, and it flags deprecated tiers
that our catalog may still list as free.

Mirrors the models.dev caching pattern in opencode.py: ETag conditional GET,
304 reuses the cached copy, failures fall back to the committed data/offers.json.
"""
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests

UPSTREAM_URL = "https://raw.githubusercontent.com/4pixeltechBR/awesome-ai-free-tiers/main/data/providers.json"
CACHE_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "offers_cache.json")

# Our catalog provider_id -> upstream provider id, for cases where names differ
PROVIDER_ALIASES = {
    "google": "google-ai-studio",
    "groq": "groq-cloud",
    "nvidia": "nvidia-nim",
    "modal": "modal-labs",
    "xai": "xai-grok",
    "mistral": "mistral-ai",
    "moonshotai": "kimi-moonshot",
    "moonshotai-cn": "kimi-moonshot",
    "zhipuai": "zhipu-ai",
    "zhipuai-coding-plan": "zhipu-ai",
    "alibaba": "alibaba-dashscope",
    "alibaba-cn": "alibaba-dashscope",
    "alibaba-coding-plan": "alibaba-dashscope",
    "alibaba-coding-plan-cn": "alibaba-dashscope",
    "alibaba-token-plan": "alibaba-dashscope",
    "alibaba-token-plan-cn": "alibaba-dashscope",
    "volcengine": "bytedance-volcano",
    "volcengine-coding-plan": "bytedance-volcano",
    "deepseek": "deepseek",
}


def _load_cache(cache_file: Optional[str]) -> Dict[str, Any]:
    if not cache_file or not os.path.exists(cache_file):
        return {}
    try:
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cache(cache_file: Optional[str], etag: Optional[str], providers: List[Dict[str, Any]]) -> None:
    if not cache_file:
        return
    try:
        os.makedirs(os.path.dirname(cache_file), exist_ok=True)
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump({
                "etag": etag,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "providers": providers,
            }, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[Upstream] Could not write metadata cache: {e}")


def _normalize_rate_limits(rl: Dict[str, Any]) -> Dict[str, Any]:
    """Extracts rpm/tpm/rpd from a rate_limits dict, handling alternate keys."""
    if not isinstance(rl, dict):
        return {}
    rpm = rl.get("rpm") or rl.get("requests_per_minute")
    tpm = rl.get("tpm") or rl.get("tokens_per_minute")
    rpd = rl.get("rpd") or rl.get("requests_per_day")
    return {k: v for k, v in (("rpm", rpm), ("tpm", tpm), ("rpd", rpd)) if v is not None}


def fetch_upstream_free_tiers(cache_file: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Pulls the upstream free-tier directory and normalizes it into our offers.json
    shape: {id, provider, title, offer_type, models_included, requires_card,
            quota_requests_day, quota_tokens_minute, quota_requests_minute,
            status, source_url, notes}.

    Returns [] on failure so callers can fall back to the committed offers.json.
    """
    cache = _load_cache(cache_file)
    cached_providers = cache.get("providers", [])

    headers = {"User-Agent": "Free-AI-Radar/1.0"}
    if cache.get("etag"):
        headers["If-None-Match"] = cache["etag"]

    try:
        res = requests.get(UPSTREAM_URL, headers=headers, timeout=30)
        if res.status_code == 304:
            print(f"[Upstream] Free tiers unchanged (304); reusing {len(cached_providers)} cached providers.")
            return _normalize(cached_providers)
        res.raise_for_status()
        raw = res.json()
    except Exception as e:
        if cached_providers:
            print(f"[Upstream] Unavailable ({e}); reusing {len(cached_providers)} cached providers.")
            return _normalize(cached_providers)
        print(f"[Upstream] Free-tier dataset unavailable ({e}).")
        return []

    providers = raw.get("providers", [])
    print(f"[Upstream] Fetched {len(providers)} providers "
          f"({sum(len(p.get('models', [])) for p in providers)} model entries), "
          f"{len(res.content) // 1024} KB response.")
    _save_cache(cache_file, res.headers.get("etag"), providers)
    return _normalize(providers)


def _normalize(providers: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Converts upstream provider records into our offer schema."""
    offers: List[Dict[str, Any]] = []
    for p in providers:
        pid = p.get("id", "")
        if not pid:
            continue
        models = p.get("models") or []
        if not models and not p.get("universal_limits") and not p.get("free_daily_allocation"):
            continue  # nothing quota-worthy
        included = []
        for m in models:
            cid = m.get("canonical_id") or m.get("id")
            if cid:
                included.append(cid)
        universal = _normalize_rate_limits(p.get("universal_limits") or p.get("rate_limits") or {})
        daily_allocation = p.get("free_daily_allocation")
        offer = {
            "id": pid,
            "provider": p.get("name") or pid,
            "title": p.get("name") or pid,
            "offer_type": p.get("billing_tier") or "permanent_quota",
            "models_included": included,
            "requires_card": bool(p.get("credit_card_required")),
            "quota_requests_day": universal.get("rpd"),
            "quota_tokens_minute": universal.get("tpm"),
            "quota_requests_minute": universal.get("rpm"),
            "status": p.get("status") or "active",
            "source_url": p.get("console_url") or p.get("base_url") or "",
            "notes": p.get("notes") or p.get("grant") or "",
        }
        if daily_allocation:
            offer["free_daily_allocation"] = daily_allocation
        # Preserve per-model rate limits (more granular than universal)
        per_model = []
        for m in models:
            cid = m.get("canonical_id") or m.get("id")
            rl = _normalize_rate_limits(m.get("rate_limits") or {})
            if cid and rl:
                per_model.append({"model_id": cid, **rl})
        if per_model:
            offer["per_model_rate_limits"] = per_model
        offers.append(offer)
    print(f"[Upstream] Normalized {len(offers)} offer(s).")
    return offers


def upstream_provider_id(our_provider_id: str) -> str:
    """Maps one of our catalog provider_ids to the upstream provider id."""
    return PROVIDER_ALIASES.get(our_provider_id, our_provider_id)
