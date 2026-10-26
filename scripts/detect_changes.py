import hashlib
import html
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# Only alert on price moves of at least this fraction (0.2 = 20%) to keep the feed useful
PRICE_DROP_ALERT_THRESHOLD = 0.2


def generate_event_id(prefix: str, identifier: str, details: str) -> str:
    seed = f"{prefix}:{identifier}:{details}"
    return hashlib.sha256(seed.encode()).hexdigest()[:16]


def model_key(model: Dict[str, Any]) -> str:
    """Groups the same model across providers.

    Keyed on the catalog model_id slug, not the display name: providers spell
    the same model differently ('Kimi Latest' vs 'MoonshotAI: Kimi Latest'),
    which split one model into two diff groups and logged duplicate events.
    Falls back to the name only when model_id is missing (legacy rows).
    """
    mid = model.get("model_id")
    if mid:
        return re.sub(r"[^a-z0-9]", "", str(mid).casefold())
    name = model.get("name", "")
    return re.sub(r"[^a-z0-9]", "", name.casefold())


def _norm_name(name: str) -> str:
    """Normalize a display name for comparison (punctuation-stripped, case-folded)."""
    return re.sub(r"[^a-z0-9]", "", str(name or "").casefold())


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


def _openrouter_entry(group: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    return next((m for m in group if m.get("provider_id") == "openrouter"), None)


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
      2. Alert messages for Telegram — prioritised and batched, never a flood:
         free transitions first, OpenRouter price changes, one digest for the rest.
         The digest itself is capped at 10 lines; everything else is sent.
    """
    old_groups = _group_by_key(old_models)
    new_groups = _group_by_key(new_models)

    # A snapshot from the pre-models.dev schema would mark everything as "new" at once
    legacy_snapshot = bool(old_models) and any("provider_id" not in m for m in old_models)

    # Track known model names to compact alerts for same-name models at new providers
    known_names: set[str] = set()
    for _, group in old_groups.items():
        rep = group[0]
        known_names.add(_norm_name(rep.get("name") or rep.get("model_id") or ""))

    # Also track names already seen this run to collapse multiple new providers for same model
    seen_this_run: set[str] = set()

    events: List[Dict[str, Any]] = []
    became_free_alerts: List[str] = []
    new_free_alerts: List[str] = []
    new_paid_alerts: List[str] = []
    price_drop_alerts: List[str] = []
    digest_lines: List[str] = []
    now = datetime.now(timezone.utc).isoformat()

    for key, group in new_groups.items():
        old_group = old_groups.get(key)
        free_now = _is_free_group(group)
        representative = next((m for m in group if m.get("provider_id") == "openrouter"), group[0])
        name = html.escape(representative.get("name") or representative.get("model_id", key))

        if old_group is None:
            is_openrouter = _openrouter_entry(group) is not None
            alerted_new = free_now or is_openrouter
            # A model_id we have never seen, but whose *display name* already
            # exists (same model now listed by a second provider) is not a real
            # debut — it gets a one-liner instead of a full alert block.
            norm_name = _norm_name(name)
            same_name = norm_name and (norm_name in known_names or norm_name in seen_this_run)
            events.append({
                "event_id": generate_event_id("new_model", key, now),
                "type": "new_free_model" if free_now else "new_model",
                "model_id": representative.get("model_id", ""),
                "provider": ", ".join(sorted({m.get("provider") or "Unknown" for m in group})),
                "detected_at": now,
                "details": _price_line(group),
                "alerted": alerted_new,
            })

            if free_now:
                if same_name:
                    new_free_alerts.append(
                        f"🎁 <b>NEW FREE</b> — {name} @ {_provider_text(group, 2)}"
                        f" · ctx {_max_context(group):,}"
                    )
                else:
                    new_free_alerts.append(
                        f"🎁 <b>NEW 100% FREE MODEL</b>\n"
                        f"<b>Model:</b> {name}\n"
                        f"<b>Available at:</b> {_provider_text(group)}\n"
                        f"<b>Context:</b> {_max_context(group):,} tokens\n"
                        f"<a href='{_link(group)}'>View in provider catalog</a>"
                    )
            elif is_openrouter:
                or_entry = _openrouter_entry(group)
                or_in = or_entry.get("input_price_per_m")
                or_out = or_entry.get("output_price_per_m")
                pricing = f"${or_in if or_in is not None else '?'} in / ${or_out if or_out is not None else '?'} out per 1M"
                if same_name:
                    new_paid_alerts.append(
                        f"🆕 {name} @ OpenRouter — {pricing}"
                        f" · ctx {_max_context(group):,}"
                    )
                else:
                    new_paid_alerts.append(
                        f"🆕 <b>New model (OpenRouter)</b>\n"
                        f"<b>Model:</b> {name}\n"
                        f"<b>Available at:</b> {_provider_text(group)}\n"
                        f"<b>Context:</b> {_max_context(group):,} tokens\n"
                        f"<b>Pricing:</b> {pricing}\n"
                        f"<a href='{html.escape(or_entry.get('provider_url') or _link(group), quote=True)}'>View on OpenRouter</a>"
                    )
            else:
                digest_lines.append(f"• {name} — {_provider_text(group, 2)} ({_price_line(group)})")
            # Remember the name so a second provider for the same model also
            # collapses to a one-liner rather than a full block.
            if norm_name:
                seen_this_run.add(norm_name)
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
                "alerted": True,
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

        # Cross-provider price change: recorded for history/dashboard, never alerted.
        # Telegram only gets OpenRouter's own changes, further below.
        old_in = _min_price(old_group, "input_price_per_m")
        new_in = _min_price(group, "input_price_per_m")
        old_out = _min_price(old_group, "output_price_per_m")
        new_out = _min_price(group, "output_price_per_m")
        if old_in is None or new_in is None:
            continue
        # Output appearing from None (or being dropped to None) is itself a
        # change, so don't skip on input alone.
        if new_in == old_in and (old_out is None) == (new_out is None) \
                and (new_out is None or new_out == old_out):
            continue

        in_direction = "increase" if new_in > old_in else "decrease" if new_in < old_in else "same"
        # A missing output price (upstream dropped the field) must not crash the
        # comparison; treat that side as unchanged in the direction labels.
        out_direction = "same"
        if old_out is not None and new_out is not None:
            out_direction = "increase" if new_out > old_out else "decrease" if new_out < old_out else "same"
        # When only the output side moved (None <-> value), pin the label to it.
        if in_direction == "same" and out_direction == "same":
            out_direction = "increase" if new_out is not None else "decrease"
        # Only one overall direction when both dimensions agree; otherwise the
        # badge would contradict the per-line details (input down + output up).
        if in_direction == out_direction:
            direction = in_direction
        elif in_direction == "same":
            direction = out_direction
        elif out_direction == "same":
            direction = in_direction
        else:
            direction = "mixed"
        price_event = {
            "event_id": generate_event_id("price_change", key, f"{old_in}/{old_out}->{new_in}/{new_out}"),
            "type": "price_change",
            "model_id": representative.get("model_id", ""),
            "provider": ", ".join(sorted({m.get("provider") or "Unknown" for m in group})),
            "detected_at": now,
            "details": f"Input: ${old_in} -> ${new_in}"
                       + (f"; output: ${old_out} -> ${new_out}" if old_out is not None and new_out is not None else ""),
            "direction": direction,
            "in_direction": in_direction,
            "out_direction": out_direction,
            "alerted": False,
        }
        events.append(price_event)
        # OpenRouter price-change alerts — both increases and decreases, >=20% only.
        # Uses OpenRouter's own row rather than the cross-provider minimum so the
        # quoted prices are actually OpenRouter's.
        old_or = _openrouter_entry(old_group)
        new_or = _openrouter_entry(group)
        if old_or and new_or:
            or_old_in = old_or.get("input_price_per_m")
            or_new_in = new_or.get("input_price_per_m")
            or_old_out = old_or.get("output_price_per_m")
            or_new_out = new_or.get("output_price_per_m")
            if isinstance(or_old_in, (int, float)) and isinstance(or_new_in, (int, float)) \
                    and (or_old_in, or_old_out) != (or_new_in, or_new_out):
                in_pct = (or_new_in - or_old_in) / or_old_in if or_old_in else 0
                out_pct = (or_new_out - or_old_out) / or_old_out \
                    if isinstance(or_old_out, (int, float)) and isinstance(or_new_out, (int, float)) and or_old_out else 0
                # 1e-12 tolerance: (1.2-1.0)/1.0 is 0.19999999999999996 in binary float
                if abs(in_pct) >= PRICE_DROP_ALERT_THRESHOLD - 1e-12 \
                        or abs(out_pct) >= PRICE_DROP_ALERT_THRESHOLD - 1e-12:
                    price_event["alerted"] = True
                    # Label from OpenRouter's own rows so the alert direction
                    # matches the prices it quotes (not the cross-provider minimum).
                    # A None side is treated as unchanged rather than crash.
                    or_in_dir = "increase" if or_new_in > or_old_in else "decrease" if or_new_in < or_old_in else "same"
                    or_out_dir = "same"
                    if isinstance(or_old_out, (int, float)) and isinstance(or_new_out, (int, float)):
                        or_out_dir = "increase" if or_new_out > or_old_out else "decrease" if or_new_out < or_old_out else "same"
                    if or_in_dir != or_out_dir and or_in_dir != "same" and or_out_dir != "same":
                        or_direction = "mixed"
                    else:
                        or_direction = or_in_dir if or_in_dir != "same" else or_out_dir
                    rising = or_direction == "increase"
                    direction_label = {
                        "increase": "Price increase",
                        "decrease": "Price drop",
                    }.get(or_direction, "Price change")
                    price_drop_alerts.append(
                        f"{'📈' if rising else '📉' if or_direction == 'decrease' else '🔄'} <b>{direction_label} (OpenRouter)</b>\n"
                        f"<b>Model:</b> {name}\n"
                        f"<b>Input:</b> ${or_old_in}/1M → <b>${or_new_in}/1M</b>\n"
                        f"<b>Output:</b> ${or_old_out if or_old_out is not None else '?'}/1M → <b>${or_new_out if or_new_out is not None else '?'}/1M</b>\n"
                        f"<a href='{html.escape(new_or.get('provider_url') or _link(group), quote=True)}'>View on OpenRouter</a>"
                    )

    if legacy_snapshot:
        # Schema migration: record history, stay silent on Telegram
        return events, []

    alerts: List[str] = []
    alerts.extend(became_free_alerts)
    alerts.extend(new_free_alerts)
    alerts.extend(new_paid_alerts)
    alerts.extend(price_drop_alerts)

    if digest_lines:
        shown = digest_lines[:10]
        extra = len(digest_lines) - len(shown)
        footer = f"\n…and {extra} more" if extra > 0 else ""
        alerts.append(
            f"📊 <b>{len(digest_lines)} new model(s) this cycle</b>\n"
            + "\n".join(shown) + footer
        )

    return events, alerts
