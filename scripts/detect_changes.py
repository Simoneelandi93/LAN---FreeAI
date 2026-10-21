import hashlib
from datetime import datetime, timezone
from typing import List, Dict, Any, Tuple

def generate_event_id(prefix: str, identifier: str, details: str) -> str:
    seed = f"{prefix}:{identifier}:{details}"
    return hashlib.sha256(seed.encode()).hexdigest()[:16]

def detect_model_changes(
    old_models: List[Dict[str, Any]],
    new_models: List[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """
    Diffs old models vs new models. Returns:
      1. List of event records for history.json
      2. List of human-readable notification strings for Telegram
    """
    old_map = {m["id"]: m for m in old_models}
    events = []
    alerts = []
    now = datetime.now(timezone.utc).isoformat()

    for m in new_models:
        mid = m["id"]
        if mid not in old_map:
            # Brand new model discovered
            is_free = m.get("is_free", False)
            events.append({
                "event_id": generate_event_id("new_model", mid, now),
                "type": "new_free_model" if is_free else "new_model",
                "model_id": m["model_id"],
                "provider": m["provider"],
                "detected_at": now,
                "details": f"Added with input: ${m['input_price_per_m']}/1M, output: ${m['output_price_per_m']}/1M"
            })
            if is_free:
                alerts.append(
                    f"🎁 <b>NEW 100% FREE MODEL</b>\n"
                    f"<b>Model:</b> <code>{m['model_id']}</code>\n"
                    f"<b>Provider:</b> {m['provider']}\n"
                    f"<b>Context:</b> {m['context_window']:,} tokens\n"
                    f"<a href='{m['source_url']}'>View Model on OpenRouter</a>"
                )
        else:
            old_m = old_map[mid]
            # Detect Price Drop to Zero
            if not old_m.get("is_free") and m.get("is_free"):
                events.append({
                    "event_id": generate_event_id("became_free", mid, now),
                    "type": "model_became_free",
                    "model_id": m["model_id"],
                    "provider": m["provider"],
                    "detected_at": now
                })
                alerts.append(
                    f"🚨 <b>PRICE DROPPED TO $0 (NOW FREE)</b>\n"
                    f"<b>Model:</b> <code>{m['model_id']}</code>\n"
                    f"<b>Previous In/Out:</b> ${old_m['input_price_per_m']} / ${old_m['output_price_per_m']}\n"
                    f"<b>Current:</b> <b>FREE</b>\n"
                    f"<a href='{m['source_url']}'>Claim / Test Endpoint</a>"
                )
            # Detect general price change (> 10% change)
            elif old_m["input_price_per_m"] != m["input_price_per_m"]:
                old_p = old_m["input_price_per_m"]
                new_p = m["input_price_per_m"]
                direction = "📉 Price Decreased" if new_p < old_p else "📈 Price Increased"
                events.append({
                    "event_id": generate_event_id("price_change", mid, f"{old_p}->{new_p}"),
                    "type": "price_change",
                    "model_id": m["model_id"],
                    "provider": m["provider"],
                    "detected_at": now,
                    "details": f"Input: ${old_p} -> ${new_p}"
                })
                if new_p < old_p:  # Only ping Telegram on drops to reduce noise
                    alerts.append(
                        f"{direction}\n"
                        f"<b>Model:</b> <code>{m['model_id']}</code>\n"
                        f"<b>Input Price:</b> ${old_p}/1M ➔ <b>${new_p}/1M</b>\n"
                        f"<a href='{m['source_url']}'>View Model</a>"
                    )

    return events, alerts
