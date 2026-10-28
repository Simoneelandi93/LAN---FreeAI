"""Audits the dashboard for the "data present but not shown" class of bug.

Run after any board/view change:  python scripts/audit_boards.py

Checks every board section of data/leaderboard.json against what the frontend
actually renders in site/app.js:
  1. every field the builder writes is referenced by the matching renderer
  2. no field is always empty
  3. price fields are per-token in the JSON and shown per-million in the UI
  4. OpenRouter ids join to the lookup index, so score + Lookup work
  5. the lookup card shows every provider field it carries
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEADERBOARD_FILE = os.path.join(ROOT, "data", "leaderboard.json")
LOOKUP_FILE = os.path.join(ROOT, "data", "lookup.json")
APP_JS = os.path.join(ROOT, "site", "app.js")

# section -> renderer function in site/app.js
BOARD_RENDERERS = {
    "usage": "renderUsageBoard",
    "free": "renderFreeBoard",
    "value": "renderValueBoard",
    "fastest": "renderFastestBoard",
    "newest": "renderNewestBoard",
}
# Fields used to join boards to the lookup index. They are inputs, not
# display columns, so their absence from a renderer is not a bug.
JOIN_FIELDS = {"openrouter_id", "raw_id", "rank", "free", "value_score"}
# Fields the builder writes that the renderer must not ignore.
MUST_SHOW = {
    "usage": ["name", "tokens_display", "requests", "change", "provider", "price_in", "price_out", "context_window"],
    "value": ["name", "price_in", "price_out", "context_window"],
    "fastest": ["name", "throughput", "latency_ms", "best_provider", "best_price_per_m"],
    "newest": ["name", "created", "context_window", "price_in", "price_out"],
}
# Fields optional per row (e.g. usage rows whose model is not on OpenRouter's
# catalog yet) — exempt from the "always empty" check.
OPTIONAL_FIELDS = {
    "usage": {"price_in", "price_out"},
}

problems = []


def fail(msg):
    problems.append(msg)
    print("  FAIL " + msg)


def ok(msg):
    print("  ok   " + msg)


def renderer_source(js: str, fn: str) -> str:
    m = re.search(r"function %s\s*\(" % re.escape(fn), js)
    if not m:
        return ""
    start = m.start()
    # Skip the parameter list, which may itself contain braces
    # (destructured defaults), so find the body brace after the matching ")".
    i = m.end() - 1
    paren = 0
    while i < len(js):
        if js[i] == "(":
            paren += 1
        elif js[i] == ")":
            paren -= 1
            if paren == 0:
                break
        i += 1
    body = js.find("{", i)
    if body == -1:
        return ""
    depth = 0
    for j in range(body, len(js)):
        if js[j] == "{":
            depth += 1
        elif js[j] == "}":
            depth -= 1
            if depth == 0:
                return js[start:j + 1]
    return js[start:]


def load_lookup():
    if not os.path.exists(LOOKUP_FILE):
        return {}
    with open(LOOKUP_FILE, encoding="utf-8") as f:
        lk = json.load(f)
    models = lk.get("models") or lk
    if isinstance(models, dict):
        return models
    return {m.get("name", ""): m for m in models if isinstance(m, dict)}


def main():
    with open(LEADERBOARD_FILE, encoding="utf-8") as f:
        lb = json.load(f)
    with open(APP_JS, encoding="utf-8") as f:
        js = f.read()
    lookup = load_lookup()
    known_ids = set()
    for entry in lookup.values():
        for p in entry.get("providers") or []:
            for key in ("full_id", "model_id"):
                if p.get(key):
                    known_ids.add(str(p[key]).lower())

    print("=== board sections ===")
    for section, fn in BOARD_RENDERERS.items():
        rows = lb.get(section)
        if section == "free":
            print(f"[free] lookup-based board, {len(lookup)} canonical models in lookup.json")
            continue
        if not isinstance(rows, list) or not rows:
            fail(f"[{section}] section missing or empty")
            continue
        src = renderer_source(js, fn)
        if not src:
            fail(f"[{section}] renderer {fn}() not found in site/app.js")
            continue
        ok(f"[{section}] {len(rows)} rows, renderer {fn}() found")

        fields = set()
        for r in rows:
            fields |= set(r.keys())
        for field in sorted(fields - JOIN_FIELDS):
            if field not in src:
                fail(f"[{section}] field '{field}' is in the data but never rendered")
        for field in MUST_SHOW.get(section, []):
            if field not in fields:
                fail(f"[{section}] expected field '{field}' missing from the data")
            elif field not in src:
                fail(f"[{section}] field '{field}' present but not rendered")

        for field in sorted(fields):
            if field in OPTIONAL_FIELDS.get(section, set()):
                continue
            empty = sum(1 for r in rows if r.get(field) in (None, "", []))
            if empty:
                fail(f"[{section}] field '{field}' empty in {empty}/{len(rows)} rows")
            else:
                ok(f"[{section}] field '{field}' populated in all rows")

        # prices must be per-token in the JSON, and the UI must scale them
        for field in ("price_in", "price_out"):
            if field not in fields:
                continue
            vals = [float(r[field]) for r in rows if r.get(field) is not None]
            if not vals:
                continue
            if max(vals) > 0.01:
                fail(f"[{section}] {field} max {max(vals)} looks like $/M, not $/token")
            elif "1e6" not in src and "1000000" not in src:
                fail(f"[{section}] {field} is per-token but the renderer never scales to per-million")
            else:
                ok(f"[{section}] {field} per-token and scaled to $/M in the UI")

        # ids must join to the lookup index
        joined = sum(1 for r in rows if r.get("openrouter_id") and r["openrouter_id"].lower() in known_ids)
        if joined < len(rows) * 0.5:
            fail(f"[{section}] only {joined}/{len(rows)} ids join to lookup.json (score + Lookup broken)")
        else:
            ok(f"[{section}] {joined}/{len(rows)} ids join to lookup.json")

    print("=== lookup cards ===")
    card_src = renderer_source(js, "lookupCardHTML")
    if not card_src:
        fail("[lookup] lookupCardHTML() not found")
    else:
        provider_fields = set()
        for entry in lookup.values():
            for p in entry.get("providers") or []:
                provider_fields |= set(p.keys())
        for field in ("provider", "model_id", "tier", "quota", "checked_at", "requires_card", "status"):
            if field not in provider_fields:
                fail(f"[lookup] provider field '{field}' never produced by the builder")
        for field in ("provider", "model_id", "quota", "checked_at", "requires_card", "status"):
            # the renderer reads these off the provider object as p.<field>,
            # or hands the whole provider to a helper (fmtChecked(p))
            if f"p.{field}" not in card_src and not (
                field == "checked_at" and "fmtChecked(p)" in card_src
            ):
                fail(f"[lookup] provider field '{field}' present but not rendered on the card")
        if "fmtCardPrice" not in card_src and "price" not in card_src:
            fail("[lookup] price is not rendered on the provider row")
        else:
            ok("[lookup] provider rows show provider, id, price, quota, checked_at, card flag")

    print()
    if problems:
        print(f"AUDIT FAILED: {len(problems)} problem(s)")
        return 1
    print("AUDIT PASSED: every board renders the data it carries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
