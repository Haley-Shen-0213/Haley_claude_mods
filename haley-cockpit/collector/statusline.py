# 路徑： collector\statusline.py
# Claude Code 狀態列（使用者層 statusLine 呼叫）：第 1 行 Claude 5 小時／7 天與 Codex 額度，第 2 行本 session 的 context、花費與全部 session 的狀態計數。
# 用法：settings.json 的 statusLine.command 設為 python -X utf8 -B <外掛資料夾>/collector/statusline.py（Windows 經 Git Bash 執行，路徑用正斜線；-B 不產生 __pycache__）。
import json
import os
import sys
import traceback

from cockpit import board, common, usage

GREEN, YELLOW, RED, DIM, CYAN, RESET = "\033[32m", "\033[33m", "\033[31m", "\033[90m", "\033[36m", "\033[0m"
_PARTS = "▏▎▍▌▋▊▉"


def color_of(pct):
    # 配色門檻：低於 50% 綠、50～80% 黃、超過 80% 紅（mod 面板用同一組）
    return GREEN if pct < 50 else (YELLOW if pct <= 80 else RED)


def bar(pct, width):
    """以 1/8 格為單位的進度條：10 格寬就有 80 階，1% 的變化也看得出來。"""
    pct = max(0.0, min(100.0, pct))
    eighths = round(pct / 100 * width * 8)
    full, part = divmod(eighths, 8)
    filled = "█" * full + (_PARTS[part - 1] if part else "")
    empty = "░" * (width - full - (1 if part else 0))
    return f"{color_of(pct)}{filled}{DIM}{empty}{RESET}"


def span(seconds):
    seconds = max(0, int(seconds))
    if seconds < 3600:
        return f"{max(1, seconds // 60)}分"
    if seconds < 86400:
        return f"{seconds // 3600}時{seconds % 3600 // 60:02d}分"
    return f"{seconds // 86400}天{seconds % 86400 // 3600}時"


def window_label(minutes):
    if minutes == 300:
        return "5h"
    if minutes == 10080:
        return "7d"
    return f"{minutes / 60:g}h" if minutes else "?"


def gauge(label, used, resets_at, now_ts, width, countdown=True):
    if used is None:
        return f"{label} {DIM}已重置{RESET}"
    text = f"{label} {bar(used, width)} {color_of(used)}{used:.0f}%{RESET}"
    if countdown and resets_at and resets_at > now_ts:
        text += f" {DIM}↻{span(resets_at - now_ts)}{RESET}"
    return text


def line_usage(snap, now_ts, cols):
    width = 10 if cols >= 110 else 6
    parts = []
    claude = snap.get("claude") or {}
    windows = [(k, claude.get(k)) for k in ("five_hour", "seven_day") if claude.get(k)]
    if windows:
        gauges = [gauge("5h" if k == "five_hour" else "7d", w.get("used"), w.get("resetsAt"), now_ts, width,
                        countdown=cols >= 90 or k == "five_hour") for k, w in windows]
        parts.append("Claude " + "  ".join(gauges))
    else:
        parts.append(f"Claude {DIM}用量待第一次回應{RESET}")
    codex = snap.get("codex")
    if codex:
        gs = []
        for key in ("primary", "secondary"):
            w = codex.get(key)
            if w:
                gs.append(gauge(window_label(w.get("windowMinutes")), w.get("used"), w.get("resetsAt"), now_ts, width,
                                countdown=cols >= 90))
        if gs:
            parts.append("Codex " + "  ".join(gs))
    return f" {DIM}│{RESET} ".join(parts)


def line_session(data, counts, cols):
    parts = []
    ctx = (data.get("context_window") or {}).get("used_percentage")
    if ctx is not None:
        parts.append(f"ctx {bar(float(ctx), 10 if cols >= 110 else 6)} {color_of(float(ctx))}{float(ctx):.0f}%{RESET}")
    cost = (data.get("cost") or {}).get("total_cost_usd")
    if cost is not None:
        parts.append(f"${float(cost):.2f}")
    left = " · ".join(parts)
    running, idle, stalled = counts.get("running", 0), counts.get("idle", 0), counts.get("stalled", 0)
    total = sum(counts.values())
    right = (f"session {total}：{GREEN}執行中 {running}{RESET} · {DIM}閒置 {idle}{RESET} · "
             f"{(RED if stalled else DIM)}停滯 {stalled}{RESET}")
    return f"{left} {DIM}│{RESET} {right}" if left else right


def main():
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    data = json.loads(raw) if raw.strip() else {}
    if len(sys.argv) > 2 and sys.argv[1] == "--dump-input":
        # 只在驗證時使用：把 Claude Code 傳來的 JSON 存檔，核對欄位
        with open(sys.argv[2], "w", encoding="utf-8") as f:
            f.write(raw)
    usage.record_claude(data.get("rate_limits"))
    result = board.collect(detail=False)
    cols = int(os.environ.get("COLUMNS") or 120)
    now_ts = result["now"]
    print(line_usage(result["usage"], now_ts, cols))
    print(line_session(data, result["counts"], cols))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception:  # noqa: BLE001 —— 狀態列出錯時仍要印出東西，錯誤細節寫進記錄檔
        os.makedirs(common.DATA_DIR, exist_ok=True)
        with open(os.path.join(common.DATA_DIR, "statusline-error.log"), "w", encoding="utf-8") as f:
            f.write(traceback.format_exc())
        print(f"{DIM}狀態列錯誤，細節見 ~/.claude/haley-cockpit/statusline-error.log{RESET}")
