# 路徑： collector\cockpit\usage_fetch.py
# 各模型的額度（例如 Fable 的每週額度）：官方狀態列與 mod 介面只給 5 小時與 7 天兩個視窗，模型專屬的額度只有內建的 /usage 指令看得到。
# 這裡以非互動模式執行官方的 /usage（本機指令：不呼叫模型、不留 session 紀錄檔），解析它印出的文字並寫進共用快取。
# 不讀取、不使用任何登入憑證：連線與驗證都由 claude 自己處理。實測約 3 秒，所以一律在背景執行，最多每 5 分鐘一次。
import datetime
import os
import re
import shutil
import subprocess
import sys
import time

from . import common, usage

REFRESH_EVERY = 300  # 秒：快取（或上一次嘗試）超過這麼久才重抓；失敗時也照這個間隔重試，不會每 30 秒敲一次
LOCK_STALE = 90      # 秒：鎖檔超過這麼久，視為上一次抓到一半就中止了
RUN_TIMEOUT = 45
LOCK_PATH = os.path.join(common.DATA_DIR, "usage-refresh.lock")
# 例：Current week (Fable): 36% used · resets Oct 22, 5:59am (Asia/Taipei)
LINE = re.compile(r"^\s*Current\s+(?P<label>[^:\r\n]+?)\s*:\s*(?P<pct>\d+(?:\.\d+)?)\s*%\s*used"
                  r"(?:\s*[·•|-]\s*resets\s+(?P<reset>[^\r\n]+?))?\s*$", re.M | re.I)
RESET = re.compile(r"(?P<mon>[A-Za-z]{3})[a-z]*\s+(?P<day>\d{1,2})\s*,?\s*(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<ap>[ap]m)", re.I)
TZ = re.compile(r"\(([^)]+)\)\s*$")
# 月份名稱不用 strptime：它會跟著系統語系走，繁體中文系統上讀不到英文月份
MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}


def _epoch(year, mon, day, hour, minute, tzname):
    if tzname:
        try:
            from zoneinfo import ZoneInfo
            return datetime.datetime(year, mon, day, hour, minute, tzinfo=ZoneInfo(tzname)).timestamp()
        except Exception:  # noqa: BLE001 —— 沒有時區資料庫或名稱不認得：改當成本機時間（官方顯示的就是本機時區）
            pass
    try:
        return time.mktime((year, mon, day, hour, minute, 0, 0, 0, -1))
    except (OverflowError, ValueError):
        return None


def parse_reset(text, now_ts):
    """「Oct 22, 5:59am (Asia/Taipei)」→ epoch 秒；沒有年份，取「不早於現在往前一天」的最近一年。"""
    text = (text or "").strip()
    m = RESET.search(text)
    mon = MONTHS.get(m.group("mon").lower()) if m else None
    if not mon:
        return None
    hour = int(m.group("h")) % 12 + (12 if m.group("ap").lower() == "pm" else 0)
    minute = int(m.group("m") or 0)
    tz = TZ.search(text)
    year = time.localtime(now_ts).tm_year
    for y in (year, year + 1):
        epoch = _epoch(y, mon, int(m.group("day")), hour, minute, tz.group(1) if tz else None)
        if epoch is not None and epoch >= now_ts - 86400:
            return epoch
    return None


def parse_usage_text(text, now_ts):
    """解析 /usage 的輸出。session＝5 小時、week (all models)＝7 天、week (某模型)＝該模型自己的每週額度。"""
    out = {"five_hour": None, "seven_day": None, "models": {}}
    for m in LINE.finditer(text or ""):
        label = m.group("label").strip()
        item = {"used": float(m.group("pct")), "resetsAt": parse_reset(m.group("reset") or "", now_ts)}
        if label.lower() == "session":
            out["five_hour"] = item
        elif label.lower().startswith("week"):
            inner = re.search(r"\(([^)]*)\)", label)
            name = inner.group(1).strip() if inner else ""
            if name.lower() in ("", "all models", "all"):
                out["seven_day"] = item
            else:
                out["models"][name] = item
    return out


def fetch(now_ts=None):
    """執行官方 /usage 並寫進快取；成功回傳解析結果，失敗回傳 None。"""
    now_ts = now_ts or common.now()
    claude = shutil.which("claude")
    if not claude:
        return None
    os.makedirs(common.DATA_DIR, exist_ok=True)
    try:
        # 在中性的資料夾執行：不受任何專案的設定與掛鉤影響；--no-session-persistence 不留紀錄檔
        p = subprocess.run([claude, "-p", "--no-session-persistence", "--model", "haiku", "/usage"], cwd=common.DATA_DIR,
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=RUN_TIMEOUT,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return None
    parsed = parse_usage_text(p.stdout.decode("utf-8", "replace"), now_ts)
    if not (parsed["five_hour"] or parsed["seven_day"] or parsed["models"]):
        return None
    usage.record_usage_text(parsed, now_ts)
    return parsed


def due(now_ts):
    cu = (common.read_json(usage.USAGE_PATH, {}) or {}).get("claudeUsage") or {}
    return now_ts - max(cu.get("seenAt") or 0, cu.get("tryAt") or 0) > REFRESH_EVERY


def _lock_is_fresh(now_ts):
    try:
        return now_ts - os.path.getmtime(LOCK_PATH) <= LOCK_STALE
    except OSError:
        return False


def maybe_spawn(now_ts):
    """該重抓時，在背景啟動一個獨立程序去抓；呼叫端（狀態列、面板）不等它，下一輪就讀得到新數字。"""
    if not due(now_ts) or _lock_is_fresh(now_ts):
        return False
    cli = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cockpit_cli.py")
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.Popen([sys.executable, "-X", "utf8", "-B", cli, "usage-refresh"], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags, close_fds=True)
    except OSError:
        return False
    return True


def run_refresh():
    """背景程序的進入點：搶鎖（同時只有一個在抓）、記下嘗試時間、抓取、放鎖。"""
    now_ts = common.now()
    os.makedirs(common.DATA_DIR, exist_ok=True)
    if _lock_is_fresh(now_ts):
        return
    try:
        os.remove(LOCK_PATH)  # 過期的鎖
    except OSError:
        pass
    try:
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except OSError:
        return
    os.close(fd)
    try:
        usage.mark_usage_try(now_ts)
        fetch(now_ts)
    finally:
        try:
            os.remove(LOCK_PATH)
        except OSError:
            pass
