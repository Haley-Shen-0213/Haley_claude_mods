# 路徑： collector\cockpit\winproc.py
# Windows 程序快照（ctypes，不另裝套件）：列出 pid、父 pid、執行檔名，按需取啟動時間；用來判斷 session 是否還活著、找出它所在的終端機。
import ctypes
import os
from ctypes import wintypes

FILETIME_EPOCH = 116444736000000000  # 1970-01-01 的 FILETIME（100 奈秒為單位，自 1601 年起算）
_TH32CS_SNAPPROCESS = 0x00000002
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


_k32 = None
if os.name == "nt":
    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    _k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    _k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    _k32.Process32FirstW.restype = wintypes.BOOL
    _k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    _k32.Process32NextW.restype = wintypes.BOOL
    _k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    _k32.GetProcessTimes.restype = wintypes.BOOL
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.CloseHandle.restype = wintypes.BOOL

_INVALID = ctypes.c_void_p(-1).value


class Processes:
    """一次快照：pid → (父 pid, 執行檔名)。啟動時間要另開程序控制代碼，所以只在需要時才查並快取。"""

    def __init__(self):
        self.table = {}
        self._created = {}
        if _k32 is None:
            return
        snap = _k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
        if not snap or snap == _INVALID:
            return
        try:
            entry = _PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(entry)
            ok = _k32.Process32FirstW(snap, ctypes.byref(entry))
            while ok:
                self.table[int(entry.th32ProcessID)] = (int(entry.th32ParentProcessID), entry.szExeFile)
                ok = _k32.Process32NextW(snap, ctypes.byref(entry))
        finally:
            _k32.CloseHandle(snap)

    def exe(self, pid):
        row = self.table.get(pid)
        return row[1] if row else None

    def created_filetime(self, pid):
        """程序啟動時間（FILETIME 整數）；查不到（已結束、權限不足）回傳 None。"""
        if pid in self._created:
            return self._created[pid]
        value = None
        if _k32 is not None and pid in self.table:
            handle = _k32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if handle:
                try:
                    times = [wintypes.FILETIME() for _ in range(4)]
                    if _k32.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
                        value = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
                finally:
                    _k32.CloseHandle(handle)
        self._created[pid] = value
        return value

    def created_epoch(self, pid):
        ft = self.created_filetime(pid)
        return None if ft is None else (ft - FILETIME_EPOCH) / 1e7

    def chain(self, pid, limit=8):
        """自己加上祖先程序的 pid 清單。父程序結束後 pid 可能被重用，所以要求父程序比子程序早啟動，否則就停在這裡。"""
        out = []
        seen = set()
        cur = pid
        while cur in self.table and cur not in seen and len(out) < limit:
            out.append(cur)
            seen.add(cur)
            parent = self.table[cur][0]
            if parent in self.table:
                child_t = self.created_filetime(cur)
                parent_t = self.created_filetime(parent)
                if child_t is not None and parent_t is not None and parent_t > child_t:
                    break
            cur = parent
        return out

    def find(self, exe_name):
        name = exe_name.lower()
        return [pid for pid, (_, exe) in self.table.items() if exe.lower() == name]

    def host(self, chain):
        """session 在哪種終端機裡：vscode＝VS Code 的整合終端機；wt＝程序鏈上看得到 Windows Terminal；
        console＝其他（例如從開始功能表開的 cmd：Windows Terminal 為預設終端機時，cmd 的父程序是 explorer，鏈上看不到它，
        所以這一類要靠視窗與分頁名稱去對應）。"""
        names = {(self.exe(p) or "").lower() for p in chain}
        if "code.exe" in names:
            return "vscode"
        if names & {"windowsterminal.exe", "openconsole.exe"}:
            return "wt"
        return "console"
