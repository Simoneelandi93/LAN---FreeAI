import hashlib
import html
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# Hard cap on how many free-model alerts one run may send (protects Telegram rate limits)
MAX_FREE_ALERTS = 5
# Only alert on price drops of at least this fraction (0.2 = 20%) to keep the feed useful
PRICE_DROP_ALERT_THRESHOLD = 0.2


def generate_event_id(prefix: str, identifier: str, details: str) -> str:
    seed = f"{prefix}:{identifier}:{details}"
    return hashlib.sha256(seed.encode()).hexdigest()[:16]


def model_key(model: Dict[str, Any]) -> str:
    """Groups the same model across providers (models.dev lists one model many times)."""
    name = model.get("name") or model.get("model_id", "")
    return re.sub(r"[^a-z0-9]", "", name.casefold())


def _group_by_key(models: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for model in models:
        key = model_key(model)
        if key:
            groups.setdefault(key, []).append(model)
    return groups


def _min_price(group: List[Dict[str, Any]], field: str) -> Optional[float]:
    values = [m.get(field) for m in group if isinstance(m.get(field), (int, float))]
    return min(values) if values else None


def _max_context(group: List[Dict[str, Any]]) -> int:
    return max((m.get("context_window") or 0) for m in group)


def _is_free_group(group: List[Dict[str, Any]]) -> bool:
    return any(m.get("is_free") for m in group)


def _provider_text(group: List[Dict[str, Any]], limit: int = 3) -> str:
    providers = sorted({m.get("provider") or "Unknown" for m in group})
    shown = ", ".join(html.escape(p) for p in providers[:limit])
    if len(providers) > limit:
        shown += f" +{len(providers) - limit} more"
    return shown


def _link(group: List[Dict[str, Any]]) -> str:
    url = next((m.get("provider_url") or m.get("source_url") for m in group
                if m.get("provider_url") or m.get("source_url")), "https://models.dev")
    return html.escape(url, quote=True)


def _price_line(group: List[Dict[str, Any]]) -> str:
    inp = _min_price(group, "input_price_per_m")
    out = _min_price(group, "output_price_per_m")
    if inp is None and out is None:
        return "Pricing unavailable"
    return f"${inp if inp is not None else '?'} in / ${out if out is not None else '?'} out per 1M"


def detect_model_changes(
    old_models: List[Dict[str, Any]],
    new_models: List[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """
    Diffs the previous snapshot against the current one. Returns:
      1. Event records for history.json
      2. Alert messages for Telegram — prioritised, batched and capped:
         free transitions first, one digest for other new models, never a flood.
    """
    old_groups = _group_by_key(old_models)
    new_groups = _group_by_key(new_models)

    # A snapshot from the pre-models.dev schema would mark everything as "new" at once
    legacy_snapshot = bool(old_models) and any("provider_id" not in m for m in old_models)

    events: List[Dict[str, Any]] = []
    became_free_alerts: List[str] = []
    new_free_alerts: List[str] = []
    price_drop_alerts: List[str] = []
    digest_lines: List[str] = []
    now = datetime.now(timezone.utc).isoformat()

    for key, group in new_groups.items():
        old_group = old_groups.get(key)
        free_now = _is_free_group(group)
        representative = next((m for m in group if m.get("provider_id") == "openrouter"), group[0])
        name = html.escape(representative.get("name") or representative.get("model_id", key))

        if old_group is None:
            events.append({
                "event_id": generate_event_id("new_model", key, now),
                "type": "new_free_model" if free_now else "new_model",
                "model_id": representative.get("model_id", ""),
                "provider": ", ".join(sorted({m.get("provider") or "Unknown" for m in group})),
                "detected_at": now,
                "details": _price_line(group),
            })

            if free_now:
                new_free_alerts.append(
                    f"🎁 <b>NEW 100% FREE MODEL</b>\n"
                    f"<b>Model:</b> {name}\n"
                    f"<b>Available at:</b> {_provider_text(group)}\n"
                    f"<b>Context:</b> {_max_context(group):,} tokens\n"
                    f"<a href='{_link(group)}'>View in provider catalog</a>"
                )
            else:
                digest_lines.append(f"• {name} — {_provider_text(group, 2)} ({_price_line(group)})")
            continue

        old_free = _is_free_group(old_group)

        # Paid -> free transition: the single most valuable signal this project tracks
        if free_now and not old_free:
            old_in = _min_price(old_group, "input_price_per_m")
            old_out = _min_price(old_group, "output_price_per_m")
            events.append({
                "event_id": generate_event_id("became_free", key, now),
                "type": "model_became_free",
                "model_id": representative.get("model_id", ""),
                "provider": ", ".join(sorted({m.get("provider") or "Unknown" for m in group})),
                "detected_at": now,
                "details": f"Was ${old_in}/{old_out} per 1M, now free",
            })
            became_free_alerts.append(
                f"🚨 <b>PRICE DROPPED TO $0 (NOW FREE)</b>\n"
                f"<b>Model:</b> {name}\n"
                f"<b>Available at:</b> {_provider_text(group)}\n"
                f"<b>Was:</b> {_price_line(old_group)}\n"
                f"<b>Now:</b> <b>FREE</b>\n"
                f"<a href='{_link(group)}'>Claim / test endpoint</a>"
            )
            continue

        # Ordinary price drops (both directions recorded, only decreases alerted)
        old_in = _min_price(old_group, "input_price_per_m")
        new_in = _min_price(group, "input_price_per_m")
        old_out = _min_price(old_group, "output_price_per_m")
        new_out = _min_price(group, "output_price_per_m")
        if old_in is None or new_in is None:
            continue
        if new_in == old_in and new_out == old_out:
            continue

        drop_pct = (old_in - new_in) / old_in if old_in else 0
        in_direction = "increase" if new_in > old_in else "decrease" if new_in < old_in else "same"
        out_direction = "increase" if new_out > old_out else "decrease" if new_out < old_out else "same"
        direction = "increase" if new_in > old_in or new_out > old_out else "decrease" if new_in < old_in or new_out < old_out else "same"
        events.append({
            "event_id": generate_event_id("price_change", key, f"{old_in}/{old_out}->{new_in}/{new_out}"),
            "type": "price_change",
            "model_id": representative.get("model_id", ""),
            "provider": ", ".join(sorted({m.get("provider") or "Unknown" for m in group})),
            "detected_at": now,
            "details": f"Input: ${old_in} -> ${new_in}; output: ${old_out} -> ${new_out}",
            "direction": direction,
            "in_direction": in_direction,
            "out_direction": out_direction,
        })
        if new_in < old_in and drop_pct >= PRICE_DROP_ALERT_THRESHOLD:
            price_drop_alerts.append(
                f"📉 <b>Price drop</b>\n"
                f"<b>Model:</b> {name}\n"
                f"<b>Available at:</b> {_provider_text(group, 2)}\n"
                f"<b>Input:</b> ${old_in}/1M → <b>${new_in}/1M</b>\n"
                f"<a href='{_link(group)}'>View in provider catalog</a>"
            )

    if legacy_snapshot:
        # Schema migration: record history, stay silent on Telegram
        return events, []

    alerts: List[str] = []
    priority = became_free_alerts + new_free_alerts
    suppressed = 0
    if len(priority) > MAX_FREE_ALERTS:
        suppressed = len(priority) - MAX_FREE_ALERTS
        priority = priority[:MAX_FREE_ALERTS]
    alerts.extend(priority)
    alerts.extend(price_drop_alerts[:MAX_FREE_ALERTS])

    if digest_lines:
        shown = digest_lines[:10]
        extra = len(digest_lines) - len(shown)
        footer = f"\n…and {extra} more" if extra > 0 else ""
        if suppressed:
            footer += f"\n+{suppressed} more free model(s) — see the dashboard"
        alerts.append(
            f"📊 <b>{len(digest_lines)} new model(s) this cycle</b>\n"
            + "\n".join(shown) + footer
        )
    elif suppressed:
        alerts.append(f"🎁 {suppressed} more free model(s) went live — see the dashboard.")

    return events, alerts
