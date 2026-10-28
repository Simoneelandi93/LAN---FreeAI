"""Builds data/leaderboard.json: OpenRouter-derived boards for the Boards tab.

Sections:
- usage:    OpenRouter real-usage rankings via whatstrending.ai/api/models (trailing
            7 days) — ingested, not computed, we don't see request traffic ourselves.
- fastest:  OpenRouter's own /rankings#performance data (p50 throughput/latency across
            providers, from their frontend API).
- value:    cheapest paid text models, computed from OpenRouter catalog pricing
            (blended input/output $/M tokens).
- newest:   newest OpenRouter text models by catalog `created` timestamp.

Every section falls back to the committed file when its source is unreachable, so a
flaky upstream never blanks a board.
"""
import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List

import requests

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
LEADERBOARD_FILE = os.path.join(DATA_DIR, "leaderboard.json")
USAGE_URL = "https://whatstrending.ai/api/models"
CATALOG_URL = "https://openrouter.ai/api/v1/models"
PERF_URL = "https://openrouter.ai/api/frontend/v1/rankings/performance"
# Keep each board a digest, not a dump.
MAX_ROWS = 50
BOARD_ROWS = 25
# A rough blend for "value": input tokens usually dominate a request, but output
# price matters enough to break ties between same-input-price models.
INPUT_WEIGHT = 0.8
OUTPUT_WEIGHT = 0.2
DATE_SUFFIX = re.compile(r"-\d{8}$")


def _get(url: str) -> Any:
    res = requests.get(url, headers={"User-Agent": "Free-AI-Radar/1.0"}, timeout=30)
    res.raise_for_status()
    return res.json()


def fetch_usage_rankings(catalog: List[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    # Price/context come from the OpenRouter catalog (keyed by the `or` id), not
    # the usage upstream's own `pricing` string — spot-checks showed it
    # disagrees with the catalog for several models (stale or rounded there).
    price_by_id = {}
    ctx_by_id = {}
    for m in catalog or []:
        mid = m.get("id") or ""
        p = m.get("pricing") or {}
        try:
            price_by_id[mid] = (float(p.get("prompt") or 0), float(p.get("completion") or 0))
        except (TypeError, ValueError):
            price_by_id[mid] = (None, None)
        ctx_by_id[mid] = m.get("context_length") or 0
    try:
        body = _get(USAGE_URL)
        rows = body.get("data") if isinstance(body, dict) else body
        if not isinstance(rows, list):
            return []
        out = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            oid = r.get("or") or ""
            pin, pout = price_by_id.get(oid, (None, None))
            out.append({
                "rank": r.get("rank"),
                "name": r.get("name") or "",
                "provider": r.get("provider") or "",
                "tokens": r.get("tokens") or 0,
                "tokens_display": r.get("scoreDisplay") or "",
                "requests": r.get("requests") or 0,
                "change": r.get("change") if isinstance(r.get("change"), (int, float)) else 0,
                "openrouter_id": oid,
                "free": "free" in str(r.get("pricing") or "").lower() or "(free)" in str(r.get("name") or "").lower(),
                # Per-token, like every other board section — the UI scales to $/M.
                "price_in": pin,
                "price_out": pout,
                "context_window": ctx_by_id.get(oid) or 0,
            })
        return out
    except Exception as e:
        print(f"[leaderboard] Usage rankings unavailable: {e}")
        return []


def fetch_catalog() -> List[Dict[str, Any]]:
    try:
        body = _get(CATALOG_URL + "?order=newest")
        rows = body.get("data") if isinstance(body, dict) else body
        return rows if isinstance(rows, list) else []
    except Exception as e:
        print(f"[leaderboard] OpenRouter catalog unavailable: {e}")
        return []


def _text_only(m: Dict[str, Any]) -> bool:
    mods = ((m.get("architecture") or {}).get("output_modalities")) or []
    return "text" in mods


def _is_variant(id: str) -> bool:
    """Batch/passthrough variants of the same model clutter a newest board."""
    return id.endswith(":batch")


def build_newest(catalog: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for m in catalog:
        if not _text_only(m) or _is_variant(m.get("id") or ""):
            continue
        rows.append({
            "openrouter_id": m.get("id") or "",
            "name": m.get("name") or "",
            "created": m.get("created") or 0,
            "context_window": m.get("context_length") or 0,
            "price_in": (m.get("pricing") or {}).get("prompt"),
            "price_out": (m.get("pricing") or {}).get("completion"),
        })
    rows.sort(key=lambda r: r["created"], reverse=True)
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows[:BOARD_ROWS]


def build_value(catalog: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Cheapest paid text models, blended input/output price per M tokens."""
    rows = []
    for m in catalog:
        if not _text_only(m) or _is_variant(m.get("id") or ""):
            continue
        p = m.get("pricing") or {}
        try:
            pin, pout = float(p.get("prompt") or 0), float(p.get("completion") or 0)
        except (TypeError, ValueError):
            continue
        if pin <= 0 and pout <= 0:
            continue  # free variants live on the free boards, not a price board
        rows.append({
            "openrouter_id": m.get("id") or "",
            "name": m.get("name") or "",
            "context_window": m.get("context_length") or 0,
            "price_in": pin,
            "price_out": pout,
            "value_score": pin * INPUT_WEIGHT + pout * OUTPUT_WEIGHT,
        })
    rows.sort(key=lambda r: r["value_score"])
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows[:BOARD_ROWS]


def _join_perf_id(oid: str, v1_ids: Dict[str, None]) -> str:
    """Map a rankings/performance dated slug to the v1 catalog id the lookup index knows.

    The two catalogs don't always order the same tokens: the performance API
    says "claude-4.5-haiku" where the v1 catalog says "claude-haiku-4.5".
    """
    if oid in v1_ids:
        return oid
    base = DATE_SUFFIX.sub("", oid)
    if base in v1_ids:
        return base
    if base + ":free" in v1_ids:
        return base + ":free"
    pref = [i for i in v1_ids if i.startswith(base) and (len(i) == len(base) or i[len(base)] in "-:@")]
    if len(pref) == 1:
        return pref[0]
    # Same vendor, same tokens, different order: the performance API writes
    # "claude-4.5-haiku" where the v1 catalog writes "claude-haiku-4.5".
    vendor, _, rest = base.partition("/")
    wanted = sorted(rest.split("-"))
    matches = []
    for cand in v1_ids:
        cvendor, _, crest = cand.partition("/")
        if cvendor != vendor:
            continue
        core = crest.split(":")[0]
        if sorted(core.split("-")) == wanted:
            matches.append(cand)
    if len(matches) == 1:
        return matches[0]
    if matches:
        # Prefer the plain id over a :batch / :free twin.
        plain = [m for m in matches if ":" not in m]
        if len(plain) == 1:
            return plain[0]
        free = [m for m in matches if m.endswith(":free")]
        if len(free) == 1:
            return free[0]
    return ""


def fetch_fastest(catalog: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """OpenRouter's own 'Fastest models' data: p50 throughput/latency per model."""
    try:
        perf = _get(PERF_URL)
        rows_raw = perf.get("data") if isinstance(perf, dict) else perf
        if isinstance(rows_raw, dict):
            rows_raw = rows_raw.get("data")
        if not isinstance(rows_raw, list):
            return []
        v1_ids = {(m.get("id") or ""): None for m in catalog}
        # p50_throughput is tok/s; price from the catalog row when joinable.
        price_by_id = {}
        for m in catalog:
            p = m.get("pricing") or {}
            try:
                price_by_id[m["id"]] = (float(p.get("prompt") or 0), float(p.get("completion") or 0))
            except (TypeError, ValueError):
                pass
        out = []
        for r in rows_raw:
            if not isinstance(r, dict) or not r.get("id"):
                continue
            oid = _join_perf_id(r["id"], v1_ids)
            pin, pout = price_by_id.get(oid, (None, None))
            out.append({
                "rank": r.get("rank"),
                "name": r.get("name") or "",
                "openrouter_id": oid,
                "raw_id": r.get("id") or "",
                "throughput": r.get("p50_throughput"),
                "latency_ms": r.get("p50_latency"),
                "best_provider": r.get("best_throughput_provider") or "",
                # $/M at the fastest provider, straight from the performance
                # API — this is the price that buys the speed, not the
                # cheapest price anywhere. Already per-million.
                "best_price_per_m": r.get("best_throughput_price"),
                "best_latency_provider": r.get("best_latency_provider") or "",
                "best_latency_price_per_m": r.get("best_latency_price"),
                # Cheapest catalog price, per token, for cross-checking.
                "price_in": pin,
                "price_out": pout,
                "provider_count": r.get("provider_count"),
            })
        out = [r for r in out if r["throughput"]]
        out.sort(key=lambda r: r["throughput"], reverse=True)
        for i, r in enumerate(out, 1):
            r["rank"] = i
        return out[:BOARD_ROWS]
    except Exception as e:
        print(f"[leaderboard] Performance data unavailable: {e}")
        return []


def main():
    existing = {}
    if os.path.exists(LEADERBOARD_FILE):
        try:
            with open(LEADERBOARD_FILE, encoding="utf-8") as f:
                existing = json.load(f) or {}
        except Exception:
            existing = {}

    catalog = fetch_catalog()
    usage = fetch_usage_rankings(catalog)
    fastest = fetch_fastest(catalog) if catalog else []
    newest = build_newest(catalog) if catalog else []
    value = build_value(catalog) if catalog else []

    payload = {
        "generated_at": existing.get("generated_at") or "",
        "source": existing.get("source") or "openrouter.ai/rankings via whatstrending.ai/api/models",
        "window": existing.get("window") or "trailing 7 days",
        "usage": usage[:MAX_ROWS] if usage else existing.get("usage", []),
        "fastest": fastest,
        "value": value,
        "newest": newest,
    }
    if usage:
        payload["generated_at"] = datetime.now(timezone.utc).isoformat()

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(LEADERBOARD_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    free_count = sum(1 for r in payload["usage"] if r.get("free"))
    print(
        f"[leaderboard] {len(payload['usage'])} usage rows ({free_count} free-flagged), "
        f"{len(payload['fastest'])} fastest, {len(payload['value'])} value, "
        f"{len(payload['newest'])} newest. Generated {payload['generated_at']}."
    )


if __name__ == "__main__":
    main()
