import json
import os
import re
from typing import Any, Dict, List

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
LOOKUP_FILE = os.path.join(DATA_DIR, "lookup.json")

# Offer types that mean "no money, ever" vs "no money until credits run out".
# Everything else the catalog can label is treated as paid.
FREE_FOREVER_TYPES = {"permanent_free", "monthly_recurring", "periodic_recurring"}
CREDIT_TYPES = {
    "welcome_credits", "developer_trial", "trial_evaluation",
    "welcome_bonus_and_budget", "onboarding_credit_and_paid",
    "trial_and_budget", "budget_gateway", "budget_pay_as_you_go",
}

# Provider prefixes models.dev vendors put in display names ("Google: Gemini Flash").
_VENDOR_PREFIX = re.compile(r"^[A-Za-z0-9._-]{1,24}:\s+")
# Decorations that don't change what model you get ("(Preview)", "Latest").
_STRIP_SUFFIX = re.compile(r"\s*\((?:preview|experimental|beta|nano banana[^)]*)\)\s*$", re.I)


def _canonical_name(name: str) -> str:
    """Display name -> canonical grouping key.

    'Google: Gemini 3 Flash Preview' and 'Gemini 3 Flash' must land on the same
    key, or the model card splits per vendor and the free-alternative search
    dead-ends. Keeps version numbers: 'Gemini 3 Flash' and 'Gemini 3.8 Flash'
    are different models with different free availability.
    """
    n = str(name or "").strip()
    n = _VENDOR_PREFIX.sub("", n)
    n = _STRIP_SUFFIX.sub("", n)
    n = re.sub(r"\s+", " ", n).strip().lower()
    return n


def _quota_text(offer: Dict[str, Any]) -> str:
    parts = []
    day = offer.get("quota_requests_day")
    minute = offer.get("quota_requests_minute")
    window = offer.get("rolling_window")
    if day:
        parts.append(f"{day:,} req/day")
    if minute:
        parts.append(f"{minute}/min")
    if window:
        parts.append(window)
    tokens = offer.get("quota_tokens_minute")
    if tokens:
        parts.append(f"{tokens:,} tok/min")
    return " · ".join(parts) if parts else ""


def _tier_for(row: Dict[str, Any]) -> str:
    """free | free_quota | credit | paid."""
    if row.get("is_free"):
        return "free_quota" if row.get("offer") else "free"
    offer_type = (row.get("offer") or {}).get("offer_type")
    if offer_type in FREE_FOREVER_TYPES:
        return "free"
    if offer_type in CREDIT_TYPES:
        return "credit"
    return "paid"


_TIER_ORDER = {"free": 0, "free_quota": 1, "credit": 2, "paid": 3}


def build_lookup(models: List[Dict[str, Any]]) -> Dict[str, Any]:
    canonical: Dict[str, Dict[str, Any]] = {}
    for m in models:
        key = _canonical_name(m.get("name") or m.get("model_id"))
        if not key:
            continue
        entry = canonical.setdefault(key, {
            "name": m.get("name") or m.get("model_id"),
            "family": m.get("family") or "",
            "llm_stats_id": m.get("llm_stats_id") or "",
            "context_window": m.get("context_window") or 0,
            "providers": [],
        })
        # Context is per-provider; keep the largest advertised window.
        if (m.get("context_window") or 0) > (entry["context_window"] or 0):
            entry["context_window"] = m["context_window"]
        if not entry["llm_stats_id"] and m.get("llm_stats_id"):
            entry["llm_stats_id"] = m["llm_stats_id"]
        offer = m.get("offer") or {}
        entry["providers"].append({
            "provider": m.get("provider") or m.get("provider_id"),
            "provider_id": m.get("provider_id") or "",
            "model_id": m.get("model_id") or "",
            "full_id": m.get("id") or "",
            "tier": _tier_for(m),
            "price_in": m.get("input_price_per_m"),
            "price_out": m.get("output_price_per_m"),
            "quota": _quota_text(offer),
            "offer_type": offer.get("offer_type") or "",
            "requires_card": bool(offer.get("requires_card")),
            "offer_url": offer.get("source_url") or "",
            "provider_url": m.get("provider_url") or m.get("source_url") or "",
            "status": m.get("status") or "",
        })

    # Sort each card's providers good -> bad: free first, cheapest tiebreak.
    for entry in canonical.values():
        entry["providers"].sort(key=lambda p: (
            _TIER_ORDER.get(p["tier"], 9),
            p["price_in"] if isinstance(p["price_in"], (int, float)) else float("inf"),
            p["provider"] or "",
        ))
        entry["best_tier"] = entry["providers"][0]["tier"] if entry["providers"] else "paid"
        entry["has_free"] = any(p["tier"] in ("free", "free_quota") for p in entry["providers"])

    return {"generated_at": "", "models": canonical}


def save_lookup(models: List[Dict[str, Any]]) -> int:
    lookup = build_lookup(models)
    from datetime import datetime, timezone
    lookup["generated_at"] = datetime.now(timezone.utc).isoformat()
    os.makedirs(os.path.dirname(LOOKUP_FILE), exist_ok=True)
    with open(LOOKUP_FILE, "w", encoding="utf-8") as f:
        json.dump(lookup, f, ensure_ascii=False, separators=(",", ":"))
    free_cards = sum(1 for e in lookup["models"].values() if e["has_free"])
    print(f"[lookup] {len(lookup['models'])} canonical models, {free_cards} with a free provider.")
    return len(lookup["models"])


if __name__ == "__main__":
    with open(os.path.join(DATA_DIR, "models.json"), encoding="utf-8") as f:
        save_lookup(json.load(f))
