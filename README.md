# 🛰️ Free AI Radar

> Automated tracker for real-time AI model pricing, permanent free tiers, and promotional rate limits. Built on GitHub Actions, GitHub Pages, and Telegram Bot API — runs at 100% zero hosting cost.

---

## ⚡ Features
- **Live OpenRouter Sync**: Ingests context windows, modalities, and auto-calculates normalized USD/1M token prices.
- **Live OpenCode Sync**: Pulls the OpenCode Zen / Inference model catalog (coding models such as `big-pickle` and `deepseek-v4.1-flash-free`), enriched with per-1M pricing and context limits from the public [models.dev](https://models.dev) catalog.
- **Zero-Cost Detection**: Automatically isolates `:free` / `-free` model variants and models whose input/output costs drop to $0.
- **Curated Provider Free Tiers**: Tracks daily request quotas and card requirements for OpenCode Zen, Groq, Google AI Studio, Cerebras, GitHub Models, Cloudflare Workers AI, and SambaNova.
- **Instant Telegram Alerts**: Sends push notifications on newly discovered free models or price drops.
- **Self-Updating Web Dashboard**: Static frontend deployed automatically to GitHub Pages.

---

## 🚀 Quick Setup (3 Minutes)

### 1. Fork or Clone the Repo
```bash
git clone https://github.com/<your-username>/free-ai-radar.git
cd free-ai-radar
```

### 2. Configure Telegram Secrets (Optional for alerts)
If you want push notifications when models become free:
1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a bot to obtain your Bot Token.
2. Send `/start` to your new bot, then visit:
   `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   and copy your numeric `id` under `chat`.
3. In your GitHub repository:
   - Go to **Settings → Secrets and variables → Actions**
   - Click **New repository secret** and add:
     - `TELEGRAM_BOT_TOKEN`: Your bot token
     - `TELEGRAM_CHAT_ID`: Your chat ID

### 3. Enable GitHub Pages
Go to your repository **Settings → Pages**.
Under **Build and deployment → Source**, change from **Deploy from a branch** to **GitHub Actions**.

### 4. Trigger First Sync
1. Go to the **Actions** tab.
2. Select **Sync Models & Quotas** on the left and click **Run workflow**.

Once completed, your live dashboard will be viewable at
`https://<your-username>.github.io/free-ai-radar/`.

---

## 💻 Local Development

```bash
# Install dependencies
pip install -r requirements.txt

# Run a test extraction and diff
python -m scripts.collect

# Preview the dashboard locally (serve from the repo root)
python -m http.server 8000
```

Open `http://localhost:8000/site/` in your browser. The frontend auto-detects both
`data/*.json` (GitHub Pages layout) and `../data/*.json` (local repo-root layout).

---

## 🔌 Data Sources

| Source | Endpoint | Notes |
|---|---|---|
| OpenRouter models | `openrouter.ai/api/v1/models` | Pricing is per-token in the API; converted to USD per 1M tokens. |
| OpenCode Zen / Inference | `opencode.ai/zen/v1/models` | Returns IDs only — no prices or context limits. |
| models.dev catalog | `models.dev/api.json` | Supplies real per-1M pricing + context limits for OpenCode models. Fetched with a conditional `ETag` request; the slimmed result is cached in `data/opencode_meta.json` (~66 KB) so unchanged runs transfer nothing. |

OpenCode's free coding models are rate-limited to roughly **200 requests per 5-hour
rolling window** — shown as `200 req / 5h` on the dashboard (`quota_requests_day: 960`
is kept as the flattened equivalent). Models without any pricing metadata are skipped
rather than being guessed as free.

---

## 📂 Project Architecture

```text
free-ai-radar/
├── .github/workflows/
│   ├── collect.yml        # Runs every 30m: scrapes, diffs, pushes to repo
│   └── deploy.yml         # Auto-deploys site + JSON data to GitHub Pages
├── data/
│   ├── models.json        # Normalized catalog snapshot
│   ├── offers.json        # Provider quotas and card requirements
│   ├── history.json       # Change event audit trail
│   └── opencode_meta.json # Cached OpenCode pricing (ETag reuse, not published)
├── sources/               # Data scrapers (OpenRouter, OpenCode, provider lists)
│   ├── openrouter.py      # openrouter.ai/api/v1/models → normalized pricing
│   ├── opencode.py        # opencode.ai/zen/v1/models + models.dev metadata
│   └── free_tiers.py      # Curated free-tier quotas
├── scripts/               # Core engine (diff logic, Telegram alerts)
└── site/                  # Zero-dependency frontend (HTML, CSS, JS)
```

---

## ⚖️ License

MIT License. Free to use, adapt, and self-host.
