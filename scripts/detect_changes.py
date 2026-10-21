import hashlib
import html
import re
from datetime import datetime, timezone
from typing import List, Dict, Any, Tuple


def generate_event_id(prefix: str, identifier: str, details: str) -> str:
    seed = f"{prefix}:{identifier}:{details}"
    return hashlib.sha256(seed.encode()).hexdigest()[:16]


def model_key(model: Dict[str, Any]) -> str:
    name = model.get("name") or model.get("model_id", "")
    return re.sub(r"[^a-z0-9]", "", name.casefold())


def detect_model_changes(
    old_models: List[Dict[str, Any]],
    new_models: List[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], List[str]]:
    old_map = {m["id"]: m for m in old_models}
    old_model_keys = {model_key(m) for m in old_models if model_key(m)}
    legacy_snapshot = bool(old_models) and any("provider_id" not in m for m in old_models)
    events = []
    alerts = []
    now = datetime.now(timezone.utc).isoformat()

    grouped_new = {}
    for model in new_models:
        key = model_key(model)
        if key and key not in old_model_keys:
            grouped_new.setdefault(key, []).append(model)

    for key, group in grouped_new.items():
        representative = next((m for m in group if m.get("provider_id") == "openrouter"), group[0])
        providers = sorted({m["provider"] for m in group})
        provider_text = ", ".join(html.escape(provider) for provider in providers)
        prices = []
        for model in group:
            if model.get("input_price_per_m") is not None and model.get("output_price_per_m") is not None:
                prices.append(f"{model['provider']}: ${model['input_price_per_m']}/$"
                              f"{model['output_price_per_m']} per 1M")
        events.append({
            "event_id": generate_event_id("new_model", key, now),
            "type": "new_model",
            "model_id": representative["model_id"],
            "provider": ", ".join(providers),
            "detected_at": now,
            "details": "; ".join(prices),
        })
        if old_models and not legacy_snapshot:
            price_lines = "\n".join(prices[:8]) or "Pricing unavailable"
            alerts.append(
                f"<b>New model listed</b>\n"
                f"<b>Model:</b> {html.escape(representative['name'])}\n"
                f"<b>Available at:</b> {provider_text}\n"
                f"{price_lines}\n"
                f"<a href='{html.escape(representative['source_url'], quote=True)}'>Provider catalog</a>"
            )

    for model in new_models:
        if model.get("provider_id") != "openrouter":
            continue
        old_model = old_map.get(model["id"])
        if not old_model or "input_price_per_m" not in old_model:
            continue
        old_input = old_model.get("input_price_per_m")
        new_input = model.get("input_price_per_m")
        old_output = old_model.get("output_price_per_m")
        new_output = model.get("output_price_per_m")
        if old_input is None or new_input is None or old_output is None or new_output is None:
            continue
        if new_input < old_input or new_output < old_output:
            events.append({
                "event_id": generate_event_id(
                    "openrouter_price_drop", model["id"],
                    f"{old_input}/{old_output}->{new_input}/{new_output}"
                ),
                "type": "price_change",
                "model_id": model["model_id"],
                "provider": model["provider"],
                "detected_at": now,
                "details": f"Input: ${old_input} -> ${new_input}; output: ${old_output} -> ${new_output}",
            })
            alerts.append(
                f"<b>OpenRouter price dropped</b>\n"
                f"<b>Model:</b> {model['name']}\n"
                f"<b>Input:</b> ${old_input}/1M → <b>${new_input}/1M</b>\n"
                f"<b>Output:</b> ${old_output}/1M → <b>${new_output}/1M</b>\n"
                f"<a href='{model['source_url']}'>View in provider catalog</a>"
            )

    return events, alerts
