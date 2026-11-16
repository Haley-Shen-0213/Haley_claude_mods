# 路徑： collector\cockpit\skills.py
# /skill-board 的資料（v1.3.0，Haley 2026-11-16 裁定 D7：預設只列使用者層與入口資料夾層；Codex 的 ~\.agents\skills 是選配，預設不讀）。
# 預設只讀兩個位置：~\.claude\skills\<名稱>\SKILL.md、<入口資料夾>\.claude\skills\<名稱>\SKILL.md；
# 每個 SKILL.md 只讀開頭 --- 之間的 name、description，不讀本文、不讀同資料夾的其他檔案。
import os

from . import common

HEAD_BYTES = 64 * 1024  # 開頭欄位不會超過這麼長；超過就當成沒有結尾的 ---


def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def parse_head(text):
    """SKILL.md 開頭 --- 之間的 name、description。支援單行值、引號，以及 > 或 | 開頭的多行值（下一行起的縮排行）。"""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    out = {}
    key = None
    block = []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if key and (line.startswith((" ", "\t")) or not line.strip()):
            block.append(line.strip())
            continue
        if key:
            out[key] = " ".join(x for x in block if x)
            key, block = None, []
        name, sep, value = line.partition(":")
        name = name.strip()
        if not sep or name not in ("name", "description"):
            continue
        value = value.strip()
        if value[:1] in (">", "|"):
            key = name
        else:
            out[name] = _unquote(value)
    else:
        return {}  # 沒有結尾的 ---：不是有效的開頭欄位
    if key:
        out[key] = " ".join(x for x in block if x)
    return out


def _read_head(path):
    try:
        with open(path, "rb") as f:
            return f.read(HEAD_BYTES).decode("utf-8-sig", "replace")
    except OSError:
        return None


def scan(folder, source):
    """folder 底下每個含 SKILL.md 的子資料夾算一個 skill；沒有 SKILL.md 的子資料夾不列。"""
    rows = []
    try:
        names = sorted(os.listdir(folder), key=str.lower)
    except OSError:
        return rows
    for d in names:
        path = os.path.join(folder, d, "SKILL.md")
        if not os.path.isfile(path):
            continue
        text = _read_head(path)
        head = parse_head(text) if text is not None else {}
        rows.append({"name": head.get("name") or d, "folder": d, "description": head.get("description") or "",
                     "source": source, "path": path, "error": None if text is not None else "讀不到 SKILL.md"})
    return rows


def codex_dir():
    """Codex 的使用者層 skills：~\\.agents\\skills（選配，設定「技能清單：也列 Codex 的 skills」打開才讀）。"""
    return os.path.join(os.path.expanduser("~"), ".agents", "skills")


def collect(entry_root, include_codex=False):
    user_dir = os.path.join(common.CLAUDE_DIR, "skills")
    entry_dir = os.path.join(entry_root, ".claude", "skills") if entry_root else None
    rows = scan(user_dir, "user")
    # 入口資料夾就是使用者資料夾時（在 ~ 開 session），兩層是同一個位置，不重複列
    if entry_dir and os.path.normcase(os.path.abspath(entry_dir)) != os.path.normcase(os.path.abspath(user_dir)):
        rows += scan(entry_dir, "entry")
    cx = codex_dir() if include_codex else None
    if cx:
        rows += scan(cx, "codex")
    return {"now": common.now(), "userDir": user_dir, "entryDir": entry_dir, "codexDir": cx, "skills": rows}
