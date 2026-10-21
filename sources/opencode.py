import json
import os
import requests
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

OPENCODE_ZEN_URL = "https://opencode.ai/zen/v1/models"
OPENCODE_INFERENCE_URL = "https://opencode.ai/inference/v1/models"
# Public catalog with authoritative per-1M pricing and context limits for OpenCode
MODELS_DEV_URL = "https://models.dev/api.json"

# Free even without a "-free" suffix (Zen entry for "test" and stale backups are excluded)
KNOWN_FREE_MODELS = {"big-pickle", "exo-free", "north-mini-code-free"}
SKIP_MODELS = {"test"}

def _fetch_model_ids() -> List[str]:
    """Fetches the live model ID list from the OpenCode Zen / Inference gateway."""
    headers = {"User-Agent": "Free-AI-Radar/1.0"}
    for url in [OPENCODE_ZEN_URL, OPENCODE_INFERENCE_URL]:
        try:
            res = requests.get(url, headers=headers, timeout=20)
            if not res.ok:
                print(f"[OpenCode] {url} returned HTTP {res.status_code}")
                continue
            data = res.json()
            raw = data.get("data", []) if isinstance(data, dict) else data
            ids = [m.get("id") for m in raw if isinstance(m, dict) and m.get("id")]
            if ids:
                return ids
        except Exception as e:
            print(f"[OpenCode] Attempt to reach {url} failed: {e}")
    return []

def _slim(record: Dict[str, Any]) -> Dict[str, Any]:
    """Keeps only the fields the dashboard needs, so the cache stays ~20 KB."""
    return {
        "name": record.get("name"),
        "description": (record.get("description") or "")[:200],
        "cost": {
            "input": record.get("cost", {}).get("input", 0),
            "output": record.get("cost", {}).get("output", 0),
        },
        "limit": {"context": record.get("limit", {}).get("context", 0)},
        "modalities": {
            "input": record.get("modalities", {}).get("input", ["text"]),
            "output": record.get("modalities", {}).get("output", ["text"]),
        },
    }

def _load_cache(cache_file: Optional[str]) -> Dict[str, Any]:
    if not cache_file or not os.path.exists(cache_file):
        return {}
    try:
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_cache(cache_file: Optional[str], etag: Optional[str], models: Dict[str, Any]) -> None:
    if not cache_file:
        return
    try:
        os.makedirs(os.path.dirname(cache_file), exist_ok=True)
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump({
                "etag": etag,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "models": models,
            }, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[OpenCode] Could not write metadata cache: {e}")

def _fetch_models_dev_metadata(cache_file: Optional[str]) -> Dict[str, Dict[str, Any]]:
    """
    Pulls pricing/context metadata from models.dev (USD per 1M tokens).

    The full catalog is ~6 MB, so this uses a conditional GET against the
    published ETag and falls back to a slimmed cache committed in the repo.
    That keeps a no-change run to a 304 with almost no payload, and keeps
    pricing available if models.dev is briefly unreachable.
    """
    cache = _load_cache(cache_file)
    cached_models: Dict[str, Any] = cache.get("models", {})

    headers = {"User-Agent": "Free-AI-Radar/1.0"}
    if cache.get("etag"):
        headers["If-None-Match"] = cache["etag"]

    try:
        res = requests.get(MODELS_DEV_URL, headers=headers, timeout=60)
        if res.status_code == 304:
            print(f"[OpenCode] models.dev unchanged (304); reusing {len(cached_models)} cached records.")
            return cached_models
        res.raise_for_status()
        catalog = res.json()
    except Exception as e:
        if cached_models:
            print(f"[OpenCode] models.dev unavailable ({e}); reusing {len(cached_models)} cached records.")
            return cached_models
        print(f"[OpenCode] models.dev metadata unavailable ({e}); using name heuristics only.")
        return {}

    meta: Dict[str, Dict[str, Any]] = {}
    for provider_key in ("opencode", "opencode-go"):
        for model_id, record in catalog.get(provider_key, {}).get("models", {}).items():
            meta.setdefault(model_id, _slim(record))

    print(f"[OpenCode] models.dev refreshed; {len(meta)} records from {len(res.content) // 1024} KB response.")
    _save_cache(cache_file, res.headers.get("etag"), meta)
    return meta

def fetch_opencode_models(cache_file: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Fetches coding models from the OpenCode Zen / Inference gateway and marks
    the free ones ("-free" suffix, known free ids, or zero input/output cost).

    cache_file: optional path for the slimmed models.dev price cache.
    """
    model_ids = _fetch_model_ids()
    if not model_ids:
        return []

    meta = _fetch_models_dev_metadata(cache_file)
    normalized = []
    skipped = 0

    for model_id in model_ids:
        if model_id in SKIP_MODELS:
            continue

        record = meta.get(model_id, {})
        cost = record.get("cost", {}) or {}
        limit = record.get("limit", {}) or {}

        name_free = "-free" in model_id.lower() or ":free" in model_id.lower() or model_id.lower() in KNOWN_FREE_MODELS

        if record:
            input_price = float(cost.get("input", 0) or 0)
            output_price = float(cost.get("output", 0) or 0)
            is_free = name_free or (input_price == 0 and output_price == 0)
        else:
            # No pricing metadata: only trust an explicit free marker, never guess $0
            if not name_free:
                skipped += 1
                continue
            input_price = output_price = 0.0
            is_free = True

        modalities_in = record.get("modalities", {}).get("input", ["text"])
        modalities_out = record.get("modalities", {}).get("output", ["text"])

        normalized.append({
            "id": f"opencode/{model_id}",
            "provider": "OpenCode",
            "model_id": model_id,
            "name": record.get("name") or model_id,
            "context_window": limit.get("context") or 0,
            "input_price_per_m": round(input_price, 4),
            "output_price_per_m": round(output_price, 4),
            "modalities": f"{','.join(modalities_in)}->{','.join(modalities_out)}",
            "is_free": is_free,
            "free_type": "coding_tier" if is_free else "none",
            "source_url": "https://opencode.ai/zen",
            "description": (record.get("description") or f"OpenCode coding model: {model_id}")[:200]
        })

    if skipped:
        print(f"[OpenCode] Skipped {skipped} model(s) with no pricing metadata and no free marker.")
    return normalized
