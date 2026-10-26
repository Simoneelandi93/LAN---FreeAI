"""
LLM Stats (llm-stats.com) enrichment.

The leaderboard page publishes its dataset as schema.org `DataDownload` entries, and
the JSON behind it is served publicly by the ZeroEval backend — no API key, no quota:

  GET https://api.zeroeval.com/leaderboard/models/full?justCanonicals=true
      -> 416 canonical models with benchmark scores, pricing, context, throughput
  GET https://api.zeroeval.com/leaderboard/indexes/compact
      -> "general" index: rank, conservative score, mu, games played per model

Models there are identified by *name*, while the models.dev catalog is provider-scoped,
so records are joined by normalized name (with word-order, model-id and typo fallbacks).

Attribution to LLM Stats is required and is rendered in the dashboard footer.
"""

import difflib
import re
import unicodedata
from typing import Any, Dict, List, Optional

import requests

ZEROEVAL_BASE = "https://api.zeroeval.com"
MODELS_ENDPOINT = "/leaderboard/models/full"
INDEXES_ENDPOINT = "/leaderboard/indexes/compact"
LLM_STATS_SITE = "https://llm-stats.com"
FUZZY_CUTOFF = 0.92
FUZZY_MARGIN = 0.02
MAX_BENCHMARKS = 6

# Preferred display order for the headline benchmarks (remaining ones follow).
BENCHMARK_ORDER = [
    "gpqa",
    "aime_2025",
    "hle",
    "swe_bench_verified",
    "swe_bench_pro",
    "mmmu",
    "mmmu_pro",
    "simpleqa",
    "browsecomp",
    "terminal_bench",
    "scicode",
    "frontiermath",
    "arc_agi_v2",
    "mmmlu",
    "tau_bench_retail",
    "osworld",
    "charxiv_r",
    "screenspot_pro",
    "mcp_atlas",
    "toolathlon",
    "apex_agents",
    "mrcr_v2",
]

BENCHMARK_LABELS = {
    "gpqa": "GPQA",
    "aime_2025": "AIME 2025",
    "hle": "HLE",
    "swe_bench_verified": "SWE-bench Verified",
    "swe_bench_pro": "SWE-bench Pro",
    "mmmu": "MMMU",
    "mmmu_pro": "MMMU-Pro",
    "simpleqa": "SimpleQA",
    "browsecomp": "BrowseComp",
    "terminal_bench": "Terminal-Bench",
    "scicode": "SciCode",
    "frontiermath": "FrontierMath",
    "arc_agi_v2": "ARC-AGI v2",
    "mmmlu": "MMMLU",
    "tau_bench_retail": "Tau-bench Retail",
    "osworld": "OSWorld",
    "charxiv_r": "CharXiv-R",
    "screenspot_pro": "ScreenSpot-Pro",
    "mcp_atlas": "MCP Atlas",
    "toolathlon": "Toolathlon",
    "apex_agents": "Apex Agents",
    "mrcr_v2": "MRCR v2",
}


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode()
    text = text.lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "", text)


def _word_key(value: Any) -> str:
    words = re.findall(r"[a-z0-9]+", str(value or "").lower())
    return "".join(sorted(words))


def _words(value: Any) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", str(value or "").lower()) if len(w) >= 3}


# Tokens that describe how a model is served, not which model it is.
QUALIFIER_TOKENS = {
    "thinking", "fast", "free", "preview", "latest", "beta", "experimental",
    "instruct", "chat", "it", "online", "reasoning", "high", "low", "medium",
}

# Organization names that are used as a prefix on catalog rows.
ORG_TOKENS = {
    "openai", "anthropic", "google", "meta", "mistral", "cohere", "amazon", "aws",
    "azure", "microsoft", "nvidia", "alibaba", "qwen", "deepseek", "moonshot",
    "moonshotai", "zhipu", "zai", "minimax", "baidu", "bytedance", "tencent", "xai",
    "ai21", "ibm", "databricks", "vercel", "openrouter", "upstage", "sao10k",
    "nousresearch", "thedrummer", "cognitivecomputations",
}


def _strip_parens(value: str) -> str:
    return re.sub(r"\([^()]*\)", " ", value)


def _strip_colon(value: str) -> str:
    if ":" in value:
        head, tail = value.split(":", 1)
        if len(head.split()) <= 3:
            return tail
    return value


def _strip_trailing_qualifiers(value: str) -> str:
    words = value.split()
    while words and re.sub(r"[^a-z0-9]", "", words[-1].lower()) in QUALIFIER_TOKENS:
        words.pop()
    return " ".join(words)


def _strip_leading_org(value: str) -> str:
    words = value.split()
    while len(words) > 2 and re.sub(r"[^a-z0-9]", "", words[0].lower()) in ORG_TOKENS:
        words.pop(0)
    return " ".join(words)


def _derived_raw_strings(name: Any) -> List[str]:
    # Raw (un-normalized) catalog-side candidate names after stripping region tags,
    # provider prefixes, routing wrappers and serving qualifiers.
    raw = str(name or "")
    base = _strip_parens(raw)
    stripped = _strip_trailing_qualifiers(_strip_colon(base))
    candidates = [
        _strip_leading_org(stripped),
        stripped,
        _strip_colon(base),
        base,
    ]
    for group in re.findall(r"\(([^()]{3,80})\)", raw):
        tokens = [t for t in re.split(r"[^A-Za-z0-9\.]+", group) if t]
        real = [t for t in tokens if t.lower() not in QUALIFIER_TOKENS]
        if (any(ch.isdigit() for ch in group) and len(tokens) >= 2) or len(real) >= 3:
            candidates.insert(0, group)
    return list(dict.fromkeys(candidates))


def _derived_variants(name: Any) -> List[str]:
    # Normalized derived candidates, plus word-sorted keys for multi-word cores.
    out = []
    for candidate in _derived_raw_strings(name):
        norm = _normalize(candidate)
        if norm:
            out.append(norm)
        word_count = len(re.findall(r"[A-Za-z0-9\.]+", candidate))
        if word_count >= 3:
            tk = _word_key(candidate)
            if tk:
                out.append(tk)
    return list(dict.fromkeys(out))


def _variants(name: Any, model_id: Any, derived: bool = False) -> List[str]:
    ids = [model_id]
    if isinstance(model_id, str) and "/" in model_id:
        ids.append(model_id.split("/")[-1])
    out: List[str] = []
    for raw in [name, *ids]:
        norm = _normalize(raw)
        if norm:
            out.append(norm)
        token_key = _word_key(raw)
        if token_key:
            out.append(token_key)
    if derived:
        out.extend(_derived_variants(name))
    return list(dict.fromkeys(out))


def _get(path: str, params: Optional[Dict[str, Any]] = None) -> Any:
    response = requests.get(
        ZEROEVAL_BASE + path,
        headers={"User-Agent": "Free-AI-Radar/1.0", "Accept": "application/json"},
        params=params or {},
        timeout=60,
    )
    response.raise_for_status()
    return response.json()


def _benchmarks(model: Dict[str, Any]) -> Dict[str, float]:
    raw = {k[: -len("_score")]: v for k, v in model.items() if k.endswith("_score")}
    ordered = [key for key in BENCHMARK_ORDER if raw.get(key) is not None]
    ordered += [key for key in raw if key not in BENCHMARK_ORDER and raw[key] is not None]
    out: Dict[str, float] = {}
    for key in ordered[:MAX_BENCHMARKS]:
        try:
            out[BENCHMARK_LABELS.get(key, key.replace("_", " ").title())] = round(float(raw[key]) * 100, 1)
        except (TypeError, ValueError):
            continue
    return out


def fetch_llm_stats() -> List[Dict[str, Any]]:
    """Fetches the public LLM Stats leaderboard dataset (no key required)."""
    try:
        models = _get(MODELS_ENDPOINT, {"justCanonicals": "true"})
    except Exception as e:
        print(f"[LLM Stats] Model fetch failed: {e}")
        return []
    if not isinstance(models, list) or not models:
        print("[LLM Stats] No models returned; skipping enrichment.")
        return []

    index: Dict[str, Dict[str, Any]] = {}
    try:
        compact = _get(INDEXES_ENDPOINT)
        # The compact index holds one leaderboard per category. We pull the overall
        # score plus the reasoning/coding/agent breakdowns so the dashboard can show
        # a single composite plus a detailed tooltip.
        for category in ("general", "reasoning", "coding", "agents"):
            g = (compact or {}).get(category) or {}
            for row in g.get("models", []):
                stats_model_id = row.get("model_id")
                if not stats_model_id:
                    continue
                entry = index.setdefault(str(stats_model_id), {})
                entry[f"{category}_rank"] = row.get("rank")
                entry[f"{category}_score"] = row.get("conservative")
                entry[f"{category}_mu"] = row.get("mu")
                entry[f"{category}_games"] = row.get("games_played")
    except Exception as e:
        print(f"[LLM Stats] Index fetch failed (continuing without ranks): {e}")

    records: List[Dict[str, Any]] = []
    for model in models:
        if not isinstance(model, dict):
            continue
        model_id = str(model.get("model_id") or "")
        if not model_id:
            continue
        ranked = index.get(model_id, {})
        # Coding metric: use the llm-stats compact "coding" arena index, so the
        # column matches llm-stats.com exactly (no SWE-bench override).
        coding_score = ranked.get("coding_score")
        records.append(
            {
                "id": model_id,
                "name": model.get("name") or model_id,
                "organization": model.get("organization"),
                "rank": ranked.get("general_rank"),
                "score": ranked.get("general_score"),
                "mu": ranked.get("general_mu"),
                "games_played": ranked.get("general_games"),
                "reasoning_rank": ranked.get("reasoning_rank"),
                "reasoning_score": ranked.get("reasoning_score"),
                "coding_rank": ranked.get("coding_rank"),
                "coding_score": coding_score,
                "agent_rank": ranked.get("agents_rank"),
                "agent_score": ranked.get("agents_score"),
                "license": model.get("license"),
                "speed": model.get("throughput"),
                "benchmarks": _benchmarks(model),
                "url": f"{LLM_STATS_SITE}/models/{model_id}",
            }
        )

    print(f"[LLM Stats] Loaded {len(records)} models, {len(index)} ranked (no API key needed).")
    return records


def _payload(record: Dict[str, Any]) -> Dict[str, Any]:
    benchmarks = record.get("benchmarks") or {}
    return {
        "id": record.get("id"),
        "name": record.get("name"),
        "organization": record.get("organization"),
        "rank": record.get("rank"),
        "score": record.get("score"),
        "mu": record.get("mu"),
        "games_played": record.get("games_played"),
        "reasoning_rank": record.get("reasoning_rank"),
        "reasoning_score": record.get("reasoning_score"),
        "coding_rank": record.get("coding_rank"),
        "coding_score": record.get("coding_score"),
        "agent_rank": record.get("agent_rank"),
        "agent_score": record.get("agent_score"),
        "license": record.get("license"),
        "speed": record.get("speed"),
        "benchmarks": benchmarks,
        "benchmark_count": len(benchmarks),
        "url": record.get("url") or f"{LLM_STATS_SITE}/models/{record.get('id')}",
    }


def stats_index(stats: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Returns {stats_id: payload} for the standalone data/llm_stats.json file."""
    return {record["id"]: _payload(record) for record in stats if record.get("id")}


def attach_llm_stats(models: List[Dict[str, Any]], stats: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Joins LLM Stats records onto catalog models by name (exact, then model-id, then fuzzy).
    Writes a compact `llm_stats_id` pointer onto each match.
    Returns a report: {"matched": n, "exact": n, "fuzzy": n, "unique_matched": n, ...}.
    """
    if not stats:
        return {"matched": 0, "exact": 0, "fuzzy": 0, "unmatched_models": len(models)}

    exact_index: Dict[str, Dict[str, Any]] = {}
    fuzzy_index: Dict[str, Dict[str, Any]] = {}
    word_index: Dict[str, List[str]] = {}

    for record in stats:
        payload = _payload(record)
        if not payload["name"] and not payload["id"]:
            continue
        for variant in _variants(payload["name"], payload["id"]):
            exact_index.setdefault(variant, payload)
        norm_name = _normalize(payload["name"] or payload["id"])
        if norm_name:
            fuzzy_index.setdefault(norm_name, payload)
            for word in _words(payload["name"] or payload["id"]):
                word_index.setdefault(word, []).append(norm_name)

    matched = exact = fuzzy = 0
    matched_names = set()
    for model in models:
        payload = None
        for variant in _variants(model.get("name"), model.get("model_id"), derived=True):
            payload = exact_index.get(variant)
            if payload:
                exact += 1
                break
        if payload is None:
            candidates: List[str] = []
            for word in _words(model.get("name")):
                candidates.extend(word_index.get(word, []))
            if candidates:
                norm = _normalize(model.get("name"))
                close = difflib.get_close_matches(norm, list(dict.fromkeys(candidates)), n=2, cutoff=FUZZY_CUTOFF)
                # Only accept a single-character-style typo of identical length, so that
                # version/qualifier variants (gpt-5.4 vs gpt-5.4-mini) never get merged.
                if close and len(close[0]) != len(norm):
                    close = []
                if close:
                    best = close[0]
                    second_ratio = (
                        difflib.SequenceMatcher(None, norm, close[1]).ratio() if len(close) > 1 else 0.0
                    )
                    best_ratio = difflib.SequenceMatcher(None, norm, best).ratio()
                    if best_ratio - second_ratio >= FUZZY_MARGIN:
                        payload = fuzzy_index[best]
                        fuzzy += 1
        if payload:
            model["llm_stats_id"] = payload["id"]
            matched += 1
            matched_names.add(_normalize(model.get("name")))

    catalog_names = {_normalize(m.get("name")) for m in models if m.get("name")}
    report = {
        "matched": matched,
        "exact": exact,
        "fuzzy": fuzzy,
        "unique_matched": len(matched_names),
        "unique_models": len(catalog_names),
        "unmatched_models": len(models) - matched,
        "stats_models": len(stats),
    }
    print(
        f"[LLM Stats] Matched {matched}/{len(models)} catalog rows "
        f"({len(matched_names)}/{len(catalog_names)} unique models; exact {exact}, fuzzy {fuzzy}) "
        f"against {len(stats)} stats records."
    )
    return report
