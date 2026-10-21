from typing import List, Dict, Any

def get_curated_free_tiers() -> List[Dict[str, Any]]:
    """
    Curated database of permanent free-tier API providers and quotas.
    Updated regularly via community catalogs and official provider pricing pages.
    """
    return [
        {
            "id": "groq-free-tier",
            "provider": "GroqCloud",
            "title": "Groq Ultra-Fast Free Tier",
            "offer_type": "permanent_quota",
            "models_included": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "gemma2-9b-it"],
            "requires_card": False,
            "quota_requests_day": 14400,
            "quota_tokens_minute": 6000,
            "status": "active",
            "source_url": "https://console.groq.com/settings/limits"
        },
        {
            "id": "google-ai-studio",
            "provider": "Google AI Studio",
            "title": "Gemini Free API Tier",
            "models_included": ["gemini-1.5-flash", "gemini-2.0-flash-exp", "gemini-1.5-pro"],
            "requires_card": False,
            "quota_requests_day": 1500,
            "quota_tokens_minute": 1000000,
            "status": "active",
            "source_url": "https://ai.google.dev/pricing"
        },
        {
            "id": "cerebras-free-tier",
            "provider": "Cerebras Cloud",
            "title": "Cerebras Inference Free Tier",
            "models_included": ["llama3.1-8b", "llama3.3-70b"],
            "requires_card": False,
            "quota_requests_day": 1000000,  # 1M tokens/day
            "quota_tokens_minute": 60000,
            "status": "active",
            "source_url": "https://cerebras.ai/pricing"
        },
        {
            "id": "github-models-preview",
            "provider": "GitHub Models",
            "title": "GitHub Models Playground & API",
            "models_included": ["gpt-4o", "claude-3-5-sonnet", "o1-mini", "llama-3.3-70b"],
            "requires_card": False,
            "quota_requests_day": 150,
            "quota_tokens_minute": 15,
            "status": "active",
            "source_url": "https://github.com/marketplace/models"
        },
        {
            "id": "cloudflare-workers-ai",
            "provider": "Cloudflare",
            "title": "Workers AI Free Neurons",
            "models_included": ["@cf/meta/llama-3.1-8b-instruct", "@cf/mistral/mistral-7b-instruct-v0.1"],
            "requires_card": False,
            "quota_requests_day": 10000,  # 10k neurons daily
            "quota_tokens_minute": None,
            "status": "active",
            "source_url": "https://developers.cloudflare.com/workers-ai/platform/pricing/"
        },
        {
            "id": "sambanova-cloud",
            "provider": "SambaNova",
            "title": "SambaNova Cloud Free Tier",
            "models_included": ["Meta-Llama-3.1-405B-Instruct", "Meta-Llama-3.3-70B-Instruct"],
            "requires_card": False,
            "quota_requests_day": 1000,
            "quota_tokens_minute": 5000,
            "status": "active",
            "source_url": "https://cloud.sambanova.ai/pricing"
        },
        {
            "id": "opencode-zen-free",
            "provider": "OpenCode Zen",
            "title": "OpenCode Free Coding Models",
            "offer_type": "coding_rolling_quota",
            "models_included": [
                "big-pickle",
                "deepseek-v4.1-flash-free",
                "glm-5.3-flash-free",
                "minimax-m3.1-flash-free",
                "mimo-v2.6-flash-free",
                "nemotron-3.5-super-vl-free",
                "nemotron-3.5-lightning-free",
                "longcat-2.5-preview-free",
                "beam-free",
                "jev-1.13-free"
            ],
            "requires_card": False,
            "quota_requests_day": 960,
            "quota_tokens_minute": None,
            "rolling_window": {"requests": 200, "window_hours": 5},
            "status": "active",
            "source_url": "https://opencode.ai/docs"
        }
    ]
