# 🛰️ Free AI Radar

> Automated tracker for AI model pricing, 100% free models, and provider free tiers. Built on GitHub Actions, GitHub Pages and the Telegram Bot API — zero hosting cost.

---

## ⚡ Features
- **Whole-catalog sync**: pulls the public [models.dev](https://models.dev) catalog — ~9,000 models across ~230 providers — every 30 minutes, with per-1M USD pricing, context windows and capabilities.
- **Benchmark enrichment**: [LLM Stats](https://llm-stats.com) scores and ranks, joined to catalog rows by model name (exact → word-order → model-id → typo). Keyless.
- **Free detection**: flags any model whose input *and* output cost are $0 (`is_free`), across every provider.
- **Prioritised Telegram alerts**: price-drops-to-$0 and brand-new free models first, then one digest for the rest — never a flood.
- **Self-updating dashboard**: filterable table (free / OpenRouter / reasoning / tool use / open weights) deployed to GitHub Pages on each data change.
- **Auto-updated free tiers**: `data/offers.json` is generated every sync from the community-maintained [awesome-ai-free-tiers](https://github.com/4pixeltechBR/awesome-ai-free-tiers) dataset (65 providers, 126 model entries with per-model rate limits), so quotas and deprecated tiers stay current without hand edits.
- **Scout view + combo builder**: ranks the best free model for every provider (by LLM Stats score, daily quota, freshness or context), flags models reachable on a local router, and builds a combo — one pick per provider — copyable as a ready-to-paste model-ID list for [9router](https://github.com/9router) or OmniRouter.
- **Model lookup**: type a model name (typos welcome — "cluade opus" finds Claude Opus) and get a card of every provider serving it, grouped free → free-with-quota → signup credits → paid, each with the exact model ID one click to copy. When a model has no free source, the closest free alternatives are suggested instead of a dead end. Backed by `data/lookup.json`, generated every sync by `scripts/build_lookup.py`.

---

## 🚀 Quick Setup (3 Minutes)

### 1. Fork or Clone the Repo
```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
```

### 2. Configure Telegram Secrets (optional, needed for alerts)
1. Message [@BotFather](https://t.me/BotFather) on Telegram, create a bot, copy the token.
2. Send `/start` to your new bot, then open
   `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   and copy the numeric `id` under `chat`.
3. In your repo: **Settings → Secrets and variables → Actions → New repository secret**
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`

### 3. Enable GitHub Pages
**Settings → Pages → Build and deployment → Source → GitHub Actions.**

### 4. Trigger First Sync
**Actions → Sync Models & Quotas → Run workflow.**

Verify your secrets at the same time: tick **“Send a Telegram test alert and exit”**. You should receive the test message within seconds. If not, the job log says which of the three cases it is:

| Log line | Meaning |
|---|---|
| `Bot token or Chat ID not configured` | A secret is missing or misnamed |
| `Failed to send message: 401` | Token is wrong |
| `Failed to send message: 400` | Chat ID wrong, or you never sent `/start` to the bot |

Your dashboard is then live at `https://<your-username>.github.io/<your-repo>/`.

---

## 🔔 Alert Behaviour

One run sends messages in this order:

1. 🚨 **Price dropped to $0** — a model that was previously paid is now free (any provider).
2. 🎁 **New 100% free model** — a free model appeared for the first time (any provider).
3. 🆕 **New model (OpenRouter)** — a paid model debuted on OpenRouter.
4. 📈📉 **OpenRouter price change** — OpenRouter's input or output price moved ≥20%, up or down (up to 10 messages per run, like every alert class).
5. 📊 **Digest** — up to 10 other new models in a single message.

Free-model alerts ($0 transitions + new free models), new OpenRouter models, and price-change alerts are all prioritised above the digest; the whole batch is capped at 10 messages per run. Rate limits (HTTP 429) are retried twice, honouring Telegram's `retry_after`.

Alerts fire only when something *changes* — a run where nothing moved sends nothing.

The dashboard logs every event regardless of whether it alerted; each changelog row shows a **📢 Telegram** / **dashboard only** badge, with **Telegram only** and **Dashboard only** filters to compare the two.

---

## 💻 Local Development

```bash
pip install -r requirements.txt

# Fetch + diff + write data/*.json (sends nothing without Telegram env vars)
python -m scripts.collect

# Verify the alert pipeline without touching the live data
TEST_ALERT=true python -m scripts.collect

# Preview the dashboard (serve from the repo root)
python -m http.server 8000
```

Open `http://localhost:8000/site/`. The frontend loads `data/*.json`, falling back to
`../data/*.json` so the same files work locally and on Pages.

---

## 🔌 Data Sources

| Source | Endpoint | Notes |
|---|---|---|
| models.dev catalog | `models.dev/api.json` | Pricing per 1M tokens, context limits, modalities, capabilities for every tracked provider. |
| LLM Stats | `api.zeroeval.com/leaderboard/models/full` + `/leaderboard/indexes/compact` | Benchmark scores and leaderboard ranks, joined to catalog rows **by model name**. Public and keyless. |
| awesome-ai-free-tiers | `4pixeltechBR/awesome-ai-free-tiers` → `data/providers.json` | Community-audited free-tier quotas, rate limits, billing tiers and deprecation status for 65 providers. Fetched with ETag caching; `data/offers_cache.json` is the local copy and `data/offers.json` the normalized output. |

### Joining LLM Stats by name

The catalog is provider-scoped (`openrouter/anthropic/claude-sonnet-4-5`), LLM Stats is
model-scoped (`Claude Sonnet 4.5`). `sources/llm_stats.py` therefore matches on
normalized names, in this order:

1. normalized display name (`Claude Sonnet 4.5` → `claudesonnet45`)
2. word-sorted name (`Claude 4.5 Sonnet` ≡ `Claude Sonnet 4.5`)
3. normalized model id (`claude-sonnet-4-5`)
4. single-character typo of identical length — qualifier variants such as
   `MiniMax M3` vs `MiniMax M3X` are deliberately **not** merged

Unmatched rows simply show `—` in the LLM Stats column; the run log reports the
match rate (`Matched 214/9168 catalog rows (exact 180, fuzzy 12)`).

**No API key needed.** The leaderboard page publishes its dataset as schema.org
`DataDownload` distributions, and the JSON behind it is served publicly:

- `GET https://api.zeroeval.com/leaderboard/models/full?justCanonicals=true`
  → 416 canonical models with benchmark scores, pricing, context and throughput
- `GET https://api.zeroeval.com/leaderboard/indexes/compact`
  → per-category indexes; `general` supplies rank, conservative score and games played

Two requests per run (`~96/day`). **Attribution is required** for public display and is
rendered in the dashboard footer. The column hides itself automatically when no
benchmark data is present, so the table looks unchanged if the source is unreachable.

Scores are stored **once** in `data/llm_stats.json` (416 records, ~150 KB); each catalog
row only carries a short `llm_stats_id` pointer, so `models.json` stays close to its
original size and the frontend joins on render.

Free = both `cost.input` and `cost.output` are `0`. Models that publish no pricing
(`null`) are treated as *unknown*, never as free.

Note: OpenCode's free coding models are rate-limited to roughly **200 requests per
5-hour rolling window** (`data/offers.json` → `rolling_window`), which is why the
dashboard shows `200 req / 5h` rather than a daily figure.

### Provider-wide quotas

Some free tiers quota the provider, not each model — e.g. NVIDIA NIM's 1,000
requests/day covers every NIM model, not one model each. When an upstream offer sets
`quota_requests_day` / `rolling_window` but lists no `models_included`, the quota is
treated as provider-wide and merged onto **every** model of that provider. Per-model
rate limits still win when both apply. This is what fills the Scout view's *Free Quota*
column for providers like `nvidia` (52 daily-quota models), `groq`, `google` and
`openrouter`.

---

## 📂 Project Architecture

```text
free-ai-radar/
├── .github/workflows/
│   ├── collect.yml        # Every 30m: fetch, diff, alert, commit data/
│   └── deploy.yml         # Publishes site/ + data/ to GitHub Pages
├── data/
│   ├── models.json        # Normalized catalog snapshot (~9k models)
│   ├── llm_stats.json     # LLM Stats score table (416 models, joined by id)
│   ├── offers.json        # Provider free tiers and quotas (curated)
│   ├── history.json       # Last 200 change events
│   └── lookup.json        # Model-centric join: canonical name → providers with tiers
├── sources/
│   ├── models_dev.py      # models.dev → normalized model records
│   ├── free_tiers_upstream.py # awesome-ai-free-tiers → normalized offers + provider aliases
│   ├── litellm.py         # LiteLLM catalog → pricing/capability enrichment
│   └── llm_stats.py       # LLM Stats public leaderboard → benchmark scores, joined by name
├── scripts/
│   ├── collect.py         # Orchestrator (fetch → diff → alert → save)
│   ├── detect_changes.py  # Grouping, free-transition and price-drop logic
│   ├── build_lookup.py    # Canonical-name grouping + per-provider tier labeling
│   └── notify_telegram.py # Batched, rate-limit-aware Telegram sender
└── site/                  # Zero-dependency frontend (HTML, CSS, JS)
```

`data/` is committed by the workflow, which is what triggers the Pages deploy.
`[skip ci]` is deliberately **not** used, since it would also skip `deploy.yml`.

### How the Scout view works

The **Scout** tab answers one question: *what's the best free model I can get from
each provider right now?*

- **Candidates** are catalog rows with `is_free` or a merged free-tier offer, grouped
  by provider. Each provider shows its single best model (highest LLM Stats score,
  context as tiebreak) plus up to 4 alternates.
- **Ranking modes**: `Score` (LLM Stats), `Quota` (daily-equivalent free requests —
  rolling windows are converted, so `200 req / 5h` ≈ 960/day), `Fresh` (models that
  appeared or turned free in the last 7 days, from `history.json`), `Context`.
- **Daily scope** filter keeps only models with an actual daily/rolling quota, so a
  combo doesn't include unlimited-but-unusable $0 rows.
- **Router column** resolves each model to a 9router / OmniRouter model ID
  (`ready` = exact match, `alt` = variant match, `add` = not routable yet).
- **Combo builder**: one pick per provider (checkbox per row), then *Copy combo* puts
  the resolved router IDs — newline-separated, one per slot — on the clipboard, ready
  to paste into the router's model list.

---

## ⚖️ License

MIT License. Free to use, adapt, and self-host.
