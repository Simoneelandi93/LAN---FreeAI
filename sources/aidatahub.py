"""Model release feed from AIDataHub.

Upstream: aidatahub.io/api/model-releases.json — 57 official releases
(Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Cohere, Qwen) plus 124
OpenRouter catalog listings. ETag-cached like the other fetchers.

Their `release` events carry an official release date that models.dev only
populates for some models, so they back the "when was this announced" column.
The OpenRouter `listing` stream is deliberately ignored: models.dev already
covers 118 of their 124 listings, and the 6 that are missing are routers and
previews rather than models.
"""
import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests

UPSTREAM_URL = "https://www.aidatahub.io/api/model-releases.json"
CACHE_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "aidatahub_cache.json")

# Audio / vision / robotics / tooling releases that our text-model catalog has
# no row for. Matched against the release NAME only — matching the summary or
# evidence text drops real text models, because a chat model's announcement
# routinely mentions its TTS, image or transcription siblings.
OUT_OF_SCOPE = (
    "grok voice", "lyria", "cohere parse", "cohere transcribe", "ocr",
    "robotics", "gemini api", "gemini cli", "tts", "transcribe",
    "image", "video",
)

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
                "events": payload.get("events", []),
            }, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[AIDataHub] Could not write cache: {e}")


def _in_scope(event: Dict[str, Any]) -> bool:
    name = str(event.get("name") or "").lower()
    return not any(marker in name for marker in OUT_OF_SCOPE)


def fetch_model_releases(cache_file: Optional[str] = None) -> List[Dict[str, Any]]:
    """Returns normalized release events; [] on failure so callers can skip."""
    path = cache_file or CACHE_FILE
    cache = _load_cache(path)
    cached = cache.get("events", [])

    headers = {"User-Agent": "Free-AI-Radar/1.0"}
    if cache.get("etag"):
        headers["If-None-Match"] = cache["etag"]

    try:
        res = requests.get(UPSTREAM_URL, headers=headers, timeout=30)
        if res.status_code == 304:
            print(f"[AIDataHub] Unchanged (304); reusing {len(cached)} cached events.")
            return _normalize(_select(cached))
        res.raise_for_status()
        payload = res.json()
    except Exception as e:
        if cached:
            print(f"[AIDataHub] Unavailable ({e}); reusing {len(cached)} cached events.")
            return _normalize(_select(cached))
        print(f"[AIDataHub] Release feed unavailable ({e}).")
        return []

    events = payload.get("events", [])
    kept = _select(events)
    print(f"[AIDataHub] Fetched {len(events)} events; {len(kept)} in-scope releases "
          f"({len(events) - len(kept)} audio/vision/listing skipped).")
    _save_cache(path, res.headers.get("etag"), payload)
    return _normalize(kept)


def _select(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keeps text-model releases only. Applied on every path, cache included —
    the 304 branch otherwise returns the raw listing stream."""
    return [e for e in events if e.get("type") == "release" and _in_scope(e)]


def _normalize(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for e in events:
        name = (e.get("name") or "").strip()
        if not name:
            continue
        out.append({
            "id": e.get("id") or "",
            "name": name,
            "provider": e.get("provider") or "",
            "model_id": e.get("modelId") or "",
            "released_at": e.get("releasedAt") or e.get("listedAt") or "",
            "availability": e.get("availability") or "",
            "source_url": e.get("sourceUrl") or "",
            "source_id": e.get("sourceId") or "",
            "summary": e.get("summary") or "",
            "first_seen_at": e.get("firstSeenAt") or "",
        })
    return out


def build_release_index(releases: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Writes the lookup table the dashboard joins catalog rows against."""
    by_name: Dict[str, Any] = {}
    for r in releases:
        key = re.sub(r"[^a-z0-9]", "", r["name"].casefold())
        if not key:
            continue
        # Keep the earliest date per name; a re-announcement should not move it.
        prev = by_name.get(key)
        if prev is None or (r["released_at"] and r["released_at"] < prev["released_at"]):
            by_name[key] = r
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "https://www.aidatahub.io/models/latest",
        "releases": by_name,
    }
