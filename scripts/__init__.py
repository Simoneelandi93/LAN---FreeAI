"""Automation scripts and alert engine for Free AI Radar."""
from .detect_changes import detect_model_changes
from .notify_telegram import send_telegram

__all__ = ["detect_model_changes", "send_telegram"]
