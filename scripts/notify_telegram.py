import os
import time
import requests

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

# Safety net: never send more than this many messages in a single run
MAX_MESSAGES_PER_RUN = 10
# Pause between messages to stay well inside Telegram's per-chat rate limit
MESSAGE_INTERVAL_SECONDS = 1.0
MAX_RETRIES_ON_429 = 2


def send_telegram(message: str) -> bool:
    """Dispatches one HTML-formatted alert, backing off if Telegram rate-limits us."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("[Telegram] Bot token or Chat ID not configured. Skipping alert.")
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "HTML",
        "disable_web_page_preview": True
    }

    for attempt in range(MAX_RETRIES_ON_429 + 1):
        try:
            res = requests.post(url, json=payload, timeout=10)
            if res.status_code == 429:
                retry_after = 1
                try:
                    retry_after = int(res.json().get("parameters", {}).get("retry_after", 1))
                except Exception:
                    pass
                wait = min(max(retry_after, 1), 30)
                if attempt < MAX_RETRIES_ON_429:
                    print(f"[Telegram] Rate limited; retrying in {wait}s.")
                    time.sleep(wait)
                    continue
                print("[Telegram] Rate limited; giving up on this message.")
                return False
            res.raise_for_status()
            return True
        except Exception as e:
            print(f"[Telegram] Failed to send message: {e}")
            return False
    return False


def send_alerts(messages) -> int:
    """Sends a batch of alerts sequentially, capped, and reports how many got through."""
    if not messages:
        print("[Telegram] No alerts to send.")
        return 0

    batch = list(messages)[:MAX_MESSAGES_PER_RUN]
    dropped = len(list(messages)) - len(batch)
    if dropped > 0:
        print(f"[Telegram] Capped batch: sending {len(batch)} message(s), dropping {dropped}.")

    sent = 0
    for index, message in enumerate(batch):
        if send_telegram(message):
            sent += 1
        if index < len(batch) - 1:
            time.sleep(MESSAGE_INTERVAL_SECONDS)

    print(f"[Telegram] Sent {sent}/{len(batch)} alert(s).")
    return sent
