"""Builds data/leaderboard.json: OpenRouter real-usage rankings for the Boards tab.

Source: whatstrending.ai/api/models — a daily republish of OpenRouter's own
token-volume rankings (openrouter.ai/rankings). Ingested, not computed: we don't
see request traffic ourselves. Falls back to the committed file when unreachable.
"""
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List

import requests

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
LEADERBOARD_FILE = os.path.join(DATA_DIR, "leaderboard.json")
USAGE_URL = "https://whatstrending.ai/api/models"
# Keep the board a digest, not a dump.
MAX_ROWS = 50


def fetch_usage_rankings() -> List[Dict[str, Any]]:
    try:
        res = requests.get(USAGE_URL, headers={"User-Agent": "Free-AI-Radar/1.0"}, timeout=30)
        res.raise_for_status()
        body = res.json()
        rows = body.get("data") if isinstance(body, dict) else body
        if not isinstance(rows, list):
            return []
        out = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            out.append({
                "rank": r.get("rank"),
                "name": r.get("name") or "",
                "provider": r.get("provider") or "",
                "tokens": r.get("tokens") or 0,
                "tokens_display": r.get("scoreDisplay") or "",
                "requests": r.get("requests") or 0,
                "change": r.get("change") if isinstance(r.get("change"), (int, float)) else 0,
                "openrouter_id": r.get("or") or "",
                "free": "free" in str(r.get("pricing") or "").lower() or "(free)" in str(r.get("name") or "").lower(),
            })
        return out
    except Exception as e:
        print(f"[leaderboard] Usage rankings unavailable: {e}")
        return []


def main():
    rows = fetch_usage_rankings()
    existing = []
    if os.path.exists(LEADERBOARD_FILE):
        try:
            with open(LEADERBOARD_FILE, encoding="utf-8") as f:
                existing = (json.load(f) or {}).get("usage", [])
        except Exception:
            existing = []
    if not rows:
        print("[leaderboard] Keeping committed leaderboard.json (fetch failed or empty).")
        return
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "openrouter.ai/rankings via whatstrending.ai/api/models",
        "window": "trailing 7 days",
        "usage": rows[:MAX_ROWS],
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(LEADERBOARD_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    free_count = sum(1 for r in payload["usage"] if r["free"])
    print(f"[leaderboard] {len(payload['usage'])} usage rows ({free_count} free-flagged), generated {payload['generated_at']}.")


if __name__ == "__main__":
    main()
