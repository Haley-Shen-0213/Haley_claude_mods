# 路徑： collector\statusline.py
# Claude Code 狀態列（使用者層 statusLine 呼叫）：第 1 行 Claude 5 小時／7 天、模型專屬額度（例如 Fable）與 Codex 額度；
# 第 2 行本 session 的 context、花費與全部 session 的狀態計數；加 --list 多一行「編號 狀態點 名稱」的 session 清單。
# 用法：settings.json 的 statusLine.command 設為 python -X utf8 -B <外掛資料夾>/collector/statusline.py [--hide-usage] [--list]
# （Windows 經 Git Bash 執行，路徑用正斜線；-B 不產生 __pycache__）。
import json
import os
import re
import sys
import traceback
import unicodedata

from cockpit import board, common, usage

GREEN, YELLOW, RED, DIM, BOLD, RESET = "\033[32m", "\033[33m", "\033[31m", "\033[90m", "\033[1m", "\033[0m"
_PARTS = "▏▎▍▌▋▊▉"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def cells(text):
    """終端機佔幾格：全形字（中文）佔 2 格。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def visible_width(text):
    return cells(_ANSI.sub("", text))


def clip(text, width):
    """截到最多 width 格；被截掉時結尾加 …。"""
    if cells(text) <= width:
        return text
    out, used = "", 0
    for ch in text:
        w = cells(ch)
        if used + w > width - 1:
            break
        out, used = out + ch, used + w
    return out + "…"


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
        # 用文字不用 ↻：部分終端機字型沒有這個符號，會畫成看不懂的字
        text += f" {DIM}{span(resets_at - now_ts)}後重置{RESET}"
    return text


def _usage_variant(snap, now_ts, width, countdown_all):
    parts = []
    claude = snap.get("claude") or {}
    gauges = []
    for kind, label in (("five_hour", "5h"), ("seven_day", "7d")):
        w = claude.get(kind)
        if w:
            gauges.append(gauge(label, w.get("used"), w.get("resetsAt"), now_ts, width, countdown=countdown_all or kind == "five_hour"))
    # 模型專屬的每週額度（例如 Fable），來自官方 /usage 的背景查詢
    for m in claude.get("models") or []:
        gauges.append(gauge(f"{m.get('label')} 7d", m.get("used"), m.get("resetsAt"), now_ts, width, countdown=countdown_all))
    parts.append("Claude " + "  ".join(gauges) if gauges else f"Claude {DIM}用量待第一次回應{RESET}")
    codex = snap.get("codex")
    if codex:
        gs = []
        for key in ("primary", "secondary"):
            w = codex.get(key)
            if w:
                gs.append(gauge(window_label(w.get("windowMinutes")), w.get("used"), w.get("resetsAt"), now_ts, width,
                                countdown=countdown_all))
        if gs:
            parts.append("Codex " + "  ".join(gs))
    return f" {DIM}│{RESET} ".join(parts)


def line_usage(snap, now_ts, cols):
    """依終端機寬度挑第一個放得下的版本：先拿掉次要視窗的重置倒數，再把進度條縮短，最後連倒數都不要。"""
    variants = ((10, True), (10, False), (6, True), (6, False), (4, False))
    for width, countdown_all in variants:
        text = _usage_variant(snap, now_ts, width, countdown_all)
        if visible_width(text) <= cols:
            return text
    return text


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


_DOT = {"running": (GREEN, "●"), "stalled": (RED, "▲"), "idle": (DIM, "○")}


def line_list(rows, current_id, cols):
    """每個 session 一格「編號:狀態點 名稱」，編號與 mod 的 /go 編號、各面板的編號相同；本 session 加粗。
    寬度不夠時先縮名稱，再不夠就只列放得下的前幾個，其餘收成「+N」。"""
    if not rows:
        return ""
    gap, min_cell = 2, 14
    budget = max(20, cols - 1)
    shown = rows
    if (budget - gap * (len(rows) - 1)) // len(rows) < min_cell:
        k = max(1, (budget + gap) // (min_cell + gap))
        shown = rows[:k]
    per = (budget - gap * (len(shown) - 1) - (6 if len(shown) < len(rows) else 0)) // len(shown)
    out = []
    for r in shown:
        color, dot = _DOT.get(r.get("state"), (YELLOW, "?"))
        name = r.get("terminal") or r.get("title") or r.get("project") or r.get("tool") or "?"
        head = f"{r.get('no', '?')}:"
        text = f"{head}{color}{dot}{RESET} {clip(name, max(4, per - cells(head) - 2))}"
        out.append(f"{BOLD}{text}{RESET}" if r.get("id") and r.get("id") == current_id else text)
    more = f"  {DIM}+{len(rows) - len(shown)}{RESET}" if len(shown) < len(rows) else ""
    return (" " * gap).join(out) + more


def main():
    args = sys.argv[1:]
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    data = json.loads(raw) if raw.strip() else {}
    if "--dump-input" in args and args.index("--dump-input") + 1 < len(args):
        # 只在驗證時使用：把 Claude Code 傳來的 JSON 存檔，核對欄位
        with open(args[args.index("--dump-input") + 1], "w", encoding="utf-8") as f:
            f.write(raw)
    # 不論畫面顯示哪幾行都要回報：其他 session、mod 面板與 VS Code 擴充都靠這兩份資料
    usage.record_claude(data.get("rate_limits"))
    usage.record_session_ctx(data)
    result = board.collect(detail=False, refresh_usage=True)
    cols = int(os.environ.get("COLUMNS") or 120)
    now_ts = result["now"]
    # --hide-usage：帳號用量改由 VS Code 狀態列顯示時，終端機只留第 2 行
    if "--hide-usage" not in args:
        print(line_usage(result["usage"], now_ts, cols))
    print(line_session(data, result["counts"], cols))
    if "--list" in args:
        print(line_list(result["sessions"], data.get("session_id"), cols))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception:  # noqa: BLE001 —— 狀態列出錯時仍要印出東西，錯誤細節寫進記錄檔
        os.makedirs(common.DATA_DIR, exist_ok=True)
        with open(os.path.join(common.DATA_DIR, "statusline-error.log"), "w", encoding="utf-8") as f:
            f.write(traceback.format_exc())
        print(f"{DIM}狀態列錯誤，細節見 ~/.claude/haley-cockpit/statusline-error.log{RESET}")
