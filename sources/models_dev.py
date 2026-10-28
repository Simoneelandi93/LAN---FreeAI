import requests
from typing import Any, Dict, List

MODELS_DEV_URL = "https://models.dev/api.json"
MODELS_DEV_PROVIDER_URL = "https://models.dev/providers/{provider}/"

# Providers whose models.dev cost is 0 because usage is metered through a PAID
# monthly plan (coding/token plans, memberships), not because inference is free.
# Verified against each provider's own pricing docs 2026-10-28. Without this,
# they pollute the Best FREE board with models that need a subscription.
PAID_PLAN_PROVIDERS = {
    "alibaba-coding-plan", "alibaba-coding-plan-cn",
    "alibaba-token-plan", "alibaba-token-plan-cn",
    "kimi-code-plan-cn", "kimi-code-plan-global",
    "kuae-cloud-coding-plan",
    "minimax-cn-coding-plan", "minimax-coding-plan",
    "nan",                     # nan.builders — membership plans (€14.99–€200/mo)
    "opencode-go",
    "scnet-token-plan",
    "tencent-coding-plan", "tencent-token-plan",
    "umans-ai-coding-plan",
    "volcengine-coding-plan",
    "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp",
    "zai-coding-plan",
    "zhipuai-coding-plan",
}


def fetch_models_dev_catalog() -> List[Dict[str, Any]]:
    headers = {"User-Agent": "Free-AI-Radar/1.0"}
    try:
        response = requests.get(MODELS_DEV_URL, headers=headers, timeout=60)
        response.raise_for_status()
        catalog = response.json()
    except Exception as e:
        print(f"[models.dev] Catalog fetch failed: {e}")
        return []

    models = []
    for provider_id, provider in catalog.items():
        provider_name = provider.get("name") or provider_id
        provider_url = MODELS_DEV_PROVIDER_URL.format(provider=provider_id)
        for model_id, model in provider.get("models", {}).items():
            cost = model.get("cost") or {}
            limit = model.get("limit") or {}
            modalities = model.get("modalities") or {}
            input_cost = cost.get("input")
            output_cost = cost.get("output")
            models.append({
                "id": f"{provider_id}/{model_id}",
                "provider_id": provider_id,
                "provider": provider_name,
                "provider_url": provider_url,
                "model_id": model_id,
                "name": model.get("name") or model_id,
                "description": (model.get("description") or "")[:500],
                "family": model.get("family") or "",
                "release_date": model.get("release_date") or "",
                "last_updated": model.get("last_updated") or "",
                "status": model.get("status") or "",
                "attachment": bool(model.get("attachment")),
                "reasoning": bool(model.get("reasoning")),
                "tool_call": bool(model.get("tool_call")),
                "structured_output": bool(model.get("structured_output")),
                "temperature": bool(model.get("temperature")),
                "open_weights": bool(model.get("open_weights")),
                "modalities_input": modalities.get("input") or [],
                "modalities_output": modalities.get("output") or [],
                "context_window": limit.get("context") or 0,
                "input_price_per_m": input_cost,
                "output_price_per_m": output_cost,
                # Zero cost means free only when the provider isn't plan-metered.
                "is_free": input_cost == 0 and output_cost == 0 and provider_id not in PAID_PLAN_PROVIDERS,
                "source_url": provider_url,
            })

    print(f"[models.dev] Loaded {len(models)} models across {len(catalog)} providers.")
    return models
