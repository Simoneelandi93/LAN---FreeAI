"""Free-tier directory from FreeInference.dev.

Upstream: freeinference.dev/data/providers.json — 37 providers, 129 free models,
with a published JSON Schema and a `data_version` fingerprint. ETag-cached.

Covers providers the awesome-ai-free-tiers dataset lacks, mostly bundled and
IDE tiers (GitHub Copilot Free, Kiro, Cursor, Kilo Gateway, Nous Portal, …).
Quota fields here are free text ("Not published", "256K - 1M"), so only the
numeric ones are parsed; the rest are kept verbatim in `notes`.

Conflict rule: awesome-ai-free-tiers wins on quota numbers because it carries
structured numeric fields. FreeInference only contributes providers the other
source does not have at all, so coverage is the union and no existing number
is ever overwritten.
"""
import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests

from sources.free_tiers_upstream import PROVIDER_ALIASES as PRIMARY_PROVIDER_ALIASES

UPSTREAM_URL = "https://www.freeinference.dev/data/providers.json"
CACHE_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "freeinference_cache.json")

# Our catalog provider_id -> FreeInference's provider name. Needed because the
# offer-map lookup normalizes ids to bare alphanumerics, so a slug like
# 'google-ai-studio-gemini-api' would never resolve to our 'google' and the
# quota would attach to nothing.
PROVIDER_ALIASES = {
    "opencode": "OpenCode Zen",
    "google": "Google AI Studio (Gemini API)",
    "huggingface": "Hugging Face",
    "mistral": "Mistral La Plateforme",
    "sambanova": "SambaNova Cloud",
    "nvidia": "NVIDIA NIM (build.nvidia.com)",
    "zai": "Z.AI (Zhipu)",
    "zhipuai": "Z.AI (Zhipu)",
    "githubcopilot": "GitHub Copilot (Free)",
    "vercel": "v0 (Vercel)",
    "kilo": "Kilo Gateway",
    "ovhcloud": "OVHcloud AI Endpoints",
    "deepseek": "DeepSeek Platform",
    "github-copilot": "GitHub Copilot (Free)",
    "hugging-face-spaces": "Hugging Face Spaces",
}

# free_type -> our offer_type. Anything unmapped keeps its upstream label.
OFFER_TYPE_MAP = {
    "Rate-limited free": "permanent_quota",
    "Rate-limited free (Free Trial)": "developer_trial",
    "Rate-limited free (Experiment)": "developer_trial",
    "Promo free (limited time)": "promo_limited",
    "Trial credits": "welcome_credits",
}

_NUM = re.compile(r"-?\d+(?:\.\d+)?")
_K = 1000
_M = 1000 * 1000


def _load_cache(path: Optional[str]) -> Dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cache(path: Optional[str], etag: Optional[str], payload: Dict[str, Any]) -> None:
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({
                "etag": etag,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "payload": payload,
            }, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[FreeInference] Could not write cache: {e}")


def _first_number(text: str, suffixes: bool = False) -> Optional[int]:
    """Pulls the first integer out of free text like '1,000 requests/day'.

    With suffixes=True a K/M/B multiplier is honoured when it is attached to
    the number ('1K RPD tier' -> 1000).
    """
    if not text:
        return None
    s = str(text).replace(",", "")
    if suffixes:
        match = re.search(r"(\d+(?:\.\d+)?)\s*([KMB])(?![a-z])", s, re.I)
        if match:
            value = float(match.group(1))
            value *= {"K": _K, "M": _M, "B": _K * _M}[match.group(2).upper()]
            return int(value)
    match = _NUM.search(s)
    if not match:
        return None
    try:
        return int(float(match.group()))
    except ValueError:
        return None


def _parse_rpd(text: str) -> Optional[int]:
    value = _first_number(text, suffixes=True)
    # A single-digit "requests per day" figure is a parsing artefact, not a tier.
    return value if value and value > 10 else None


def _parse_tpm(text: str) -> Optional[int]:
    """Handles '12K', '1M' and '256K - 1M' style values by taking the first bound.

    The K/M suffix must be anchored to the number itself: '256K' is 256,000 but
    '25' followed by an unrelated 'K' elsewhere in the string is just 25.
    """
    if not text:
        return None
    s = str(text).replace(",", "")
    match = re.search(r"(\d+(?:\.\d+)?)\s*([KMB])(?![a-z])", s, re.I)
    if match:
        value = float(match.group(1))
        value *= {"K": _K, "M": _M, "B": _K * _M}[match.group(2).upper()]
        return int(value)
    return _first_number(s)


def fetch_free_inference(cache_file: Optional[str] = None) -> List[Dict[str, Any]]:
    """Returns normalized offers; [] on failure so callers can skip the merge."""
    path = cache_file or CACHE_FILE
    cache = _load_cache(path)
    cached = cache.get("payload", {})

    headers = {"User-Agent": "Free-AI-Radar/1.0"}
    if cache.get("etag"):
        headers["If-None-Match"] = cache["etag"]

    try:
        res = requests.get(UPSTREAM_URL, headers=headers, timeout=30)
        if res.status_code == 304:
            print(f"[FreeInference] Unchanged (304); reusing {len(cached.get('providers', []))} cached providers.")
            return _normalize(cached)
        res.raise_for_status()
        payload = res.json()
    except Exception as e:
        if cached:
            print(f"[FreeInference] Unavailable ({e}); reusing cached providers.")
            return _normalize(cached)
        print(f"[FreeInference] Free-tier directory unavailable ({e}).")
        return []

    providers = payload.get("providers", [])
    secondary = payload.get("secondary") or []
    print(f"[FreeInference] Fetched {len(providers)} providers (+{len(secondary)} secondary), "
          f"{sum(len(p.get('models', [])) for p in providers)} model entries, "
          f"{len(res.content) // 1024} KB response.")
    _save_cache(path, res.headers.get("etag"), payload)
    return _normalize(payload)


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")


def _normalize(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Converts FreeInference providers into our offer schema.

    `models_included` is left empty on purpose: their model names are display
    labels ("Big Pickle"), not catalog ids, so an empty list lets the
    provider-wide quota fall back to every model of that provider instead of
    attaching a wrong id.
    """
    offers: List[Dict[str, Any]] = []
    for p in payload.get("providers", []):
        name = (p.get("name") or "").strip()
        if not name:
            continue
        free_type = p.get("free_type") or ""
        notes_parts = []
        if p.get("notes"):
            notes_parts.append(str(p["notes"]))
        if p.get("access_method"):
            notes_parts.append(f"access: {p['access_method']}")
        if p.get("verified_method"):
            notes_parts.append(f"verified: {p['verified_method']}")

        # Only quota fields that parse to real numbers are trusted; the rest
        # stay in notes so the UI shows them without inventing a figure.
        rpd = None
        tpm = None
        rpm = None
        for m in p.get("models", []):
            rpd = rpd or _parse_rpd(m.get("rpd"))
            tpm = tpm or _parse_tpm(m.get("tpm"))
            rpm = rpm or _parse_rpd(m.get("rpm"))
        if not (rpd or tpm or rpm):
            # No quota at all: still worth listing as a free tier, but flagged
            # so the Scout view's quota column stays honest.
            notes_parts.append("quota: not published")

        offers.append({
            "id": _slugify(name),
            "provider": name,
            "title": name,
            "offer_type": OFFER_TYPE_MAP.get(free_type, free_type or "permanent_quota"),
            "models_included": [],
            "requires_card": False,
            "quota_requests_day": rpd,
            "quota_tokens_minute": tpm,
            "quota_requests_minute": rpm,
            "status": "active",
            "source_url": p.get("url") or "",
            "base_url": p.get("base_url") or "",
            "notes": " | ".join(notes_parts),
            "checked_at": p.get("verified") or "",
            "data_source": "freeinference",
        })
    print(f"[FreeInference] Normalized {len(offers)} offer(s).")
    return offers


def _bare(value: str) -> str:
    """The same normalization the offer-map lookup uses, so keys line up."""
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def unresolved_offers(offers: List[Dict[str, Any]], catalog_provider_ids: List[str]) -> List[str]:
    """Ids in the merged offer list that match no catalog provider.

    An offer whose id matches nothing is inert — it can't mark a model free and
    can't fill a quota column — so the run log reports them instead of letting
    them vanish silently. The primary source's alias table is applied, since it
    stores providers under upstream names ('google-ai-studio') that only reach
    the catalog through PROVIDER_ALIASES.
    """
    known = {_bare(p) for p in catalog_provider_ids}
    # An offer stored under an upstream name ('google-ai-studio') is resolved
    # when its catalog spelling ('google') exists.
    for our_pid, upstream_pid in PRIMARY_PROVIDER_ALIASES.items():
        if _bare(our_pid) in known:
            known.add(_bare(upstream_pid))
    return [o.get("id", "") for o in offers if _bare(o.get("id")) not in known]


def merge_offers(primary: List[Dict[str, Any]], secondary: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Unions two offer lists; the primary source wins on conflict.

    awesome-ai-free-tiers is primary: it carries structured numeric quotas.
    FreeInference is secondary: it only adds providers the primary lacks, so
    its free-text figures never overwrite a real number.

    Secondary offers whose provider we already track are remapped onto the
    catalog id (`google-ai-studio-gemini-api` -> `google`) and then dropped as
    duplicates, so their quota is not lost under an id the lookup can't match.
    """
    # Every provider spelling the primary source already covers: its own offer
    # ids, plus the upstream ids those map to in the shared PROVIDER_ALIASES
    # table. Compared in one pass against the secondary offers, so a provider
    # is recognized under either name and its structured quotas always win.
    by_id: Dict[str, Dict[str, Any]] = {}
    covered: set = set()
    for offer in primary:
        oid = _bare(offer.get("id"))
        if not oid:
            continue
        by_id[oid] = offer
        covered.add(oid)
        # 'google-ai-studio' -> 'google': the catalog id is covered too.
        for our_pid, upstream_pid in PRIMARY_PROVIDER_ALIASES.items():
            if _bare(upstream_pid) == oid:
                covered.add(_bare(our_pid))
        # 'zhipu-ai' is an offer id, not a catalog provider_id — the catalog
        # spells them 'zai' / 'zhipuai'. Without this the secondary's
        # 'zaizhipu' slug is treated as a brand-new provider and kept.
        if oid == "zhipuai":
            covered.update({"zai", "zaizhipu"})

    added = 0
    skipped = 0
    for offer in secondary:
        oid = _bare(offer.get("id"))
        if not oid:
            continue
        # Re-point onto our catalog id when this is a provider we already
        # serve under a different display name.
        target = oid
        for our_pid, their_name in PROVIDER_ALIASES.items():
            if _bare(their_name) == oid:
                target = _bare(our_pid)
                break
        if oid in covered or target in covered:
            skipped += 1
            continue
        # Providers the primary lacks can still be catalog providers under a
        # different name ('Kilo Gateway' vs our 'kilo'); re-point so the quota
        # lookup can match them instead of leaving an inert slug.
        if target != oid:
            offer = dict(offer, id=target)
        by_id[target] = offer
        added += 1
    print(f"[FreeInference] Added {added} provider(s) the primary source lacked "
          f"({skipped} already covered by the primary source).")
    return list(by_id.values())
