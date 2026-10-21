import requests
import xml.etree.ElementTree as ET
from typing import List, Dict, Any

try:
    import feedparser
    HAS_FEEDPARSER = True
except ImportError:
    HAS_FEEDPARSER = False

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
OPENROUTER_RSS_URL = "https://openrouter.ai/rss.xml"

def fetch_openrouter_models() -> List[Dict[str, Any]]:
    """Fetches real-time model list and pricing from OpenRouter API."""
    headers = {"User-Agent": "Free-AI-Radar/1.0"}
    try:
        response = requests.get(OPENROUTER_MODELS_URL, headers=headers, timeout=20)
        response.raise_for_status()
        raw_models = response.json().get("data", [])
    except Exception as e:
        print(f"[OpenRouter] API error: {e}")
        return []

    normalized = []
    for m in raw_models:
        model_id = m.get("id", "")
        pricing = m.get("pricing", {})

        prompt_cost = float(pricing.get("prompt", 0) or 0) * 1_000_000
        completion_cost = float(pricing.get("completion", 0) or 0) * 1_000_000
        is_free = ":free" in model_id or (prompt_cost == 0 and completion_cost == 0)

        normalized.append({
            "id": f"openrouter/{model_id}",
            "provider": "OpenRouter",
            "model_id": model_id,
            "name": m.get("name", model_id),
            "context_window": m.get("context_length", 0),
            "input_price_per_m": round(prompt_cost, 4),
            "output_price_per_m": round(completion_cost, 4),
            "modalities": m.get("architecture", {}).get("modality", "text->text"),
            "is_free": is_free,
            "free_type": "endpoint" if is_free else "none",
            "source_url": f"https://openrouter.ai/models/{model_id}",
            "description": (m.get("description") or "")[:200]
        })
    return normalized

def check_openrouter_rss() -> List[Dict[str, str]]:
    """Checks the OpenRouter RSS feed with feedparser, or falls back to xml.etree."""
    new_entries = []
    try:
        if HAS_FEEDPARSER:
            feed = feedparser.parse(OPENROUTER_RSS_URL)
            for entry in feed.entries[:10]:
                new_entries.append({
                    "title": entry.title,
                    "link": entry.link,
                    "published": entry.get("published", "")
                })
        else:
            # Zero-dependency XML fallback if feedparser isn't installed locally
            res = requests.get(OPENROUTER_RSS_URL, timeout=10)
            if res.ok:
                root = ET.fromstring(res.content)
                for item in root.findall(".//item")[:10]:
                    new_entries.append({
                        "title": item.findtext("title", ""),
                        "link": item.findtext("link", ""),
                        "published": item.findtext("pubDate", "")
                    })
            else:
                print(f"[RSS Parser] Feed returned HTTP {res.status_code}; no entries parsed.")
    except Exception as e:
        print(f"[RSS Parser] Feed note: {e}")
    return new_entries
