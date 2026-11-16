# 路徑： collector\cockpit\updater.py
# 自動更新（v1.2.0）與狀態列啟動程式。
# - 從市集安裝的外掛放在 <快取>\<市集>\haley-cockpit\<版本>\，路徑隨版本改變；從資料夾載入（CLAUDE_CODE_PLUGIN_DIRS）的不檢查更新。
# - 連網的是官方 claude 程式（claude plugin marketplace update／claude plugin update），本程式自己不連網。
# - 狀態列設定固定指向 ~\.claude\haley-cockpit\statusline_launcher.py；mod 每次載入時改寫它，指向目前載入的版本。
import json
import os
import re
import shutil
import subprocess
import time

from . import common

PLUGIN = "haley-cockpit"
STATE_PATH = os.path.join(common.DATA_DIR, "update.json")
LAUNCHER_PATH = os.path.join(common.DATA_DIR, "statusline_launcher.py")
CHECK_EVERY = 3600       # 秒：同一台電腦多個 session 開啟時，一小時內只向市集查一次
RUN_TIMEOUT = 120
MODES = ("不問不做", "可選", "全自動")
DEFAULT_MODE = MODES[0]


def cache_root():
    env = os.environ.get("CLAUDE_CODE_PLUGIN_CACHE_DIR")
    return os.path.abspath(env) if env else os.path.join(common.CLAUDE_DIR, "plugins", "cache")


def install_kind(root):
    """外掛根目錄在快取底下（<快取>/<市集>/<外掛>/<版本>）＝市集安裝，回傳 ("marketplace", 市集名)；否則 ("local", None)。"""
    try:
        rel = os.path.relpath(os.path.abspath(root), cache_root())
    except ValueError:  # 不同磁碟機
        return "local", None
    parts = rel.replace("\\", "/").split("/")
    if rel.startswith("..") or len(parts) < 3 or parts[1] != PLUGIN:
        return "local", None
    return "marketplace", parts[0]


def plugin_version(root):
    try:
        with open(os.path.join(root, ".claude-plugin", "plugin.json"), encoding="utf-8") as f:
            return str(json.load(f).get("version") or "") or None
    except (OSError, ValueError):
        return None


def version_key(v):
    """「1.10.0」比「1.9.2」新：逐段比數字，不是字串比較。"""
    return tuple(int(x) for x in re.findall(r"\d+", v or ""))


def _claude():
    return shutil.which("claude")


def _run(args):
    exe = _claude()
    if not exe:
        return 127, "", "找不到 claude 指令"
    try:
        p = subprocess.run([exe, *args], cwd=common.DATA_DIR, stdin=subprocess.DEVNULL, capture_output=True,
                           timeout=RUN_TIMEOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError) as err:
        return 1, "", str(err)
    return p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")


def marketplace_dir(name):
    """市集在本機的 clone 位置，取自 claude plugin marketplace list --json 的 installLocation。"""
    rc, out, _ = _run(["plugin", "marketplace", "list", "--json"])
    if rc != 0:
        return None
    try:
        rows = json.loads(out)
    except ValueError:
        return None
    for r in rows if isinstance(rows, list) else []:
        if r.get("name") == name and r.get("installLocation"):
            return r["installLocation"]
    return None


def latest_version(mdir):
    """市集目錄裡本外掛的 plugin.json 版本；來源路徑取自 .claude-plugin/marketplace.json。"""
    try:
        with open(os.path.join(mdir, ".claude-plugin", "marketplace.json"), encoding="utf-8") as f:
            entries = json.load(f).get("plugins") or []
    except (OSError, ValueError):
        return None
    for e in entries:
        if e.get("name") == PLUGIN and isinstance(e.get("source"), str):
            return plugin_version(os.path.join(mdir, e["source"])) or e.get("version")
    return None


def read_state():
    return common.read_json(STATE_PATH, {}) or {}


def write_state(**changes):
    st = read_state()
    st.update(changes)
    common.write_json_atomic(STATE_PATH, st)
    return st


def write_launcher(root):
    """狀態列的固定入口：內容只有目前載入的外掛位置；位置沒變就不重寫。"""
    script = os.path.join(os.path.abspath(root), "collector", "statusline.py")
    body = ("# 由 haley-cockpit 自動產生，請勿手動修改：狀態列固定執行這支，它再執行目前載入的外掛版本。\n"
            "import os, runpy, sys\n"
            f"SCRIPT = {script!r}\n"
            "sys.argv[0] = SCRIPT\n"
            "sys.path.insert(0, os.path.dirname(SCRIPT))\n"
            "runpy.run_path(SCRIPT, run_name='__main__')\n")
    try:
        with open(LAUNCHER_PATH, encoding="utf-8") as f:
            if f.read() == body:
                return False
    except OSError:
        pass
    os.makedirs(common.DATA_DIR, exist_ok=True)
    tmp = LAUNCHER_PATH + f".{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)
    os.replace(tmp, LAUNCHER_PATH)
    return True


def startup(root, check, now_ts=None):
    """mod 載入時呼叫：改寫狀態列啟動程式；市集安裝且 check 時查新版（一小時內用上次結果）。"""
    now_ts = now_ts or common.now()
    kind, market = install_kind(root)
    st = read_state()
    out = {"kind": kind, "marketplace": market, "installed": plugin_version(root), "latest": None,
           "available": False, "asked": bool(st.get("asked")), "launcherWritten": False, "error": None}
    try:
        out["launcherWritten"] = write_launcher(root)
    except OSError as err:
        out["error"] = f"寫狀態列啟動程式失敗：{err}"
    if kind != "marketplace" or not check:
        return out
    if now_ts - (st.get("checkedAt") or 0) < CHECK_EVERY and st.get("marketplace") == market:
        latest = st.get("latest")
    else:
        rc, _, err = _run(["plugin", "marketplace", "update", market])
        mdir = marketplace_dir(market)
        latest = latest_version(mdir) if mdir else None
        if rc != 0 or not latest:
            out["error"] = f"查詢市集失敗：{(err or '').strip().splitlines()[-1] if (err or '').strip() else '讀不到最新版本'}"
            write_state(checkedAt=now_ts, marketplace=market, latest=None)
            return out
        write_state(checkedAt=now_ts, marketplace=market, latest=latest)
    out["latest"] = latest
    out["available"] = bool(latest and out["installed"] and version_key(latest) > version_key(out["installed"]))
    return out


def mark_asked():
    write_state(asked=True, askedAt=common.now())
    return {"asked": True}


def apply(market):
    """執行官方更新；新版在 /reload-plugins 或下一個 session 生效。"""
    if not re.fullmatch(r"[0-9A-Za-z._-]{1,100}", market or ""):
        return {"ok": False, "message": "市集名稱不正確"}
    rc, out, err = _run(["plugin", "update", f"{PLUGIN}@{market}"])
    text = (out.strip() or err.strip()).splitlines()
    if rc == 0:
        write_state(updatedAt=time.time())
    return {"ok": rc == 0, "message": text[-1] if text else f"結束碼 {rc}"}
