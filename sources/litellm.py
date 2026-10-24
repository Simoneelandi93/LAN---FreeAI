import json
import os
import re
from typing import Any, Dict, List

LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"


def _norm_id(value: str) -> str:
    v = str(value or "").lower()
    if "/" in v:
        v = v.rsplit("/", 1)[-1]
    return re.sub(r"[^a-z0-9]", "", v)


def fetch_litellm_catalog() -> List[Dict[str, Any]]:
    """Fetch LiteLLM's model price/context file and return a list of enriched entries."""
    try:
        import requests
        response = requests.get(LITELLM_URL, timeout=60)
        response.raise_for_status()
        data = response.json()
    except Exception as e:
        print(f"[litellm] Fetch failed: {e}")
        return []

    entries = []
    for key, info in data.items():
        # LiteLLM keys are formatted as "provider/model_name" where provider
        # is the litellm_provider and model_name is the identifier within that provider.
        # Some keys have nested paths like "vercel_ai_gateway/morph/morph-v3-large"
        # where "vercel_ai_gateway" is the provider and "morph/morph-v3-large" is the model.
        # We split on the first "/" to get provider and model_name.
        if "/" in key:
            provider, model_name = key.split("/", 1)
        else:
            provider = info.get("litellm_provider", "")
            model_name = key

        entries.append({
            "litellm_key": key,
            "litellm_provider": provider,
            "model_name": model_name,
            "max_input_tokens": info.get("max_input_tokens") or info.get("max_tokens") or 0,
            "max_output_tokens": info.get("max_output_tokens") or 0,
            "input_cost_per_token": info.get("input_cost_per_token"),
            "output_cost_per_token": info.get("output_cost_per_token"),
            "supports_reasoning": info.get("supports_reasoning"),
            "supports_vision": info.get("supports_vision"),
            "supports_function_calling": info.get("supports_function_calling"),
            "supports_prompt_caching": info.get("supports_prompt_caching"),
            "supports_tool_choice": info.get("supports_tool_choice"),
            "supports_response_schema": info.get("supports_response_schema"),
            "mode": info.get("mode", ""),
            "source": info.get("source", ""),
            "supported_endpoints": info.get("supported_endpoints", []),
        })

    print(f"[litellm] Loaded {len(entries)} entries.")
    return entries


def enrich_models(models: List[Dict[str, Any]], litellm_entries: List[Dict[str, Any]]) -> None:
    """Join LiteLLM data onto models by normalized model id."""
    ll_by_norm = {}
    for entry in litellm_entries:
        nk = _norm_id(entry["litellm_key"])
        ll_by_norm[nk] = entry

    for m in models:
        mid = m.get("model_id") or m.get("name") or ""
        pid = m.get("provider_id", "")
        n_direct = _norm_id(f"{pid}/{mid}")
        n_mid = _norm_id(mid)
        ll = ll_by_norm.get(n_direct) or ll_by_norm.get(n_mid)
        if ll:
            m["litellm"] = ll