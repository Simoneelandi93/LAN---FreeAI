import json
import os
from datetime import datetime, timezone
from typing import Any
from sources.models_dev import fetch_models_dev_catalog
from scripts.detect_changes import detect_model_changes
from scripts.notify_telegram import send_telegram

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
MODELS_FILE = os.path.join(DATA_DIR, "models.json")
OFFERS_FILE = os.path.join(DATA_DIR, "offers.json")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
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

def main():
    print(f"[{datetime.now(timezone.utc).isoformat()}] Starting AI Catalog Sync...")

    old_models = load_json(MODELS_FILE, [])
    old_history = load_json(HISTORY_FILE, [])

    # 1. Fetch the complete provider and model catalog
    new_models = fetch_models_dev_catalog()
    curated_offers = load_json(OFFERS_FILE, [])

    if not new_models:
        print("[Warn] No models fetched from providers. Keeping old snapshot.")
        new_models = old_models
    # 2. Diff and detect changes (dispatches alerts for new OpenCode free drops too!)
    events, alerts = detect_model_changes(old_models, new_models)
    print(f"[Diff] Detected {len(events)} new events and {len(alerts)} priority alerts.")

    # 3. Send Telegram alerts
    for alert in alerts:
        send_telegram(alert)

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
