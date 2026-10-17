# 路徑： collector\cockpit\common.py
# 駕駛艙共用工具：資料夾位置、ISO 時間換算、原子寫檔、讀檔尾，以及停滯門檻設定值。
import calendar
import json
import os
import re
import time

HOME = os.path.expanduser("~")
CLAUDE_DIR = os.path.join(HOME, ".claude")
CODEX_DIR = os.path.join(HOME, ".codex")
# 駕駛艙自己產生的資料（用量快取、增量解析快取、切換請求）放 Claude 使用者資料夾底下而不放外掛資料夾：
# 外掛資料夾可能在版控裡（每次更新都變成未提交變更），也可能是安裝時複製的副本（更新外掛就被換掉）。
# HALEY_COCKPIT_DATA 只給測試用：拿假資料測狀態列時，不要寫進真正的用量快取。
DATA_DIR = os.environ.get("HALEY_COCKPIT_DATA") or os.path.join(CLAUDE_DIR, "haley-cockpit")
CACHE_DIR = os.path.join(DATA_DIR, "cache")
# 各 Claude session 的狀態列回報自己的 context 比例（只有 Claude Code 自己知道視窗大小）
CTX_DIR = os.path.join(DATA_DIR, "ctx")
# VS Code 擴充回報各視窗的終端機名稱與 shell pid，總覽用它顯示和分頁清單一樣的名稱
TERMINALS_DIR = os.path.join(DATA_DIR, "terminals")
PLUGIN_NAME = "haley-cockpit"
DEFAULT_STALL_MINUTES = 10

_ISO = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$")


def now():
    return time.time()


def iso_to_epoch(text):
    """ISO 8601 → epoch 秒。手寫解析而不用 datetime.fromisoformat：Codex 的 session_index 用 7 位小數，舊版 Python 不收。"""
    if not isinstance(text, str):
        return None
    m = _ISO.match(text.strip())
    if not m:
        return None
    y, mo, d, h, mi, s, frac, tz = m.groups()
    t = calendar.timegm((int(y), int(mo), int(d), int(h), int(mi), int(s)))
    if frac:
        t += float("0." + frac)
    if tz and tz != "Z":
        sign = 1 if tz[0] == "+" else -1
        hh, mm = int(tz[1:3]), int(tz[-2:])
        t -= sign * (hh * 3600 + mm * 60)
    return t


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json_atomic(path, obj):
    """先寫暫存檔再取代：多個 session 的狀態列會同時讀寫同一份快取，半寫入的檔案會讓別人讀到壞 JSON。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    try:
        os.replace(tmp, path)
    except OSError:
        # Windows 上對方正好開著目標檔時取代會失敗；這次放棄即可，下次呼叫再寫。
        try:
            os.remove(tmp)
        except OSError:
            pass


def read_tail_lines(path, max_bytes=256 * 1024):
    """讀檔尾 max_bytes，回傳（檔案實際大小, 完整行的 bytes 清單）。
    大小用開檔後 seek 取得：寫入端一直開著檔案時，os.stat 的大小與修改時間在 Windows 上可能停在舊值。"""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            start = max(0, size - max_bytes)
            f.seek(start)
            data = f.read()
    except OSError:
        return 0, []
    if start > 0:
        cut = data.find(b"\n")
        data = data[cut + 1:] if cut >= 0 else b""
    return size, [line for line in data.split(b"\n") if line.strip()]


def loads(line):
    try:
        obj = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        return None
    return obj if isinstance(obj, dict) else None


def stall_minutes(override=None):
    """停滯門檻（分鐘）：命令列參數優先，其次是 mod 的 /config 設定值（settings.json 的 pluginConfigs），都沒有用預設 10。"""
    if override is not None:
        try:
            v = float(override)
            if v > 0:
                return v
        except ValueError:
            pass
    settings = read_json(os.path.join(CLAUDE_DIR, "settings.json"), {}) or {}
    configs = settings.get("pluginConfigs") or {}
    for key in (PLUGIN_NAME, PLUGIN_NAME + "@inline"):
        opts = (configs.get(key) or {}).get("options") or {}
        try:
            v = float(opts.get("stallMinutes"))
            if v > 0:
                return v
        except (TypeError, ValueError):
            continue
    return float(DEFAULT_STALL_MINUTES)


def project_name(cwd):
    return os.path.basename((cwd or "").rstrip("\\/")) or (cwd or "")
