"""Forge Code post-update smoke test. Exit 0 = PASS."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from ctypes import wintypes
import ctypes

ROOT = os.path.dirname(os.path.abspath(__file__))
PYW = r"C:\Users\dedge\AppData\Local\Programs\Python\Python314\pythonw.exe"
APP = os.path.join(ROOT, "app.py")
UI_REPORT = os.path.join(ROOT, "user-data", "last_ui.json")
SCREENSHOT = os.path.join(ROOT, "_ui_check.png")
fails: list[str] = []


def step(name: str, ok: bool, detail: str = "") -> None:
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def kill_fadf() -> None:
    try:
        out = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process "
                "| Where-Object { "
                "    ($_.Name -match 'python(w)?\\.exe') -and "
                "    ($_.CommandLine -match 'fadf\\\\app\\.py|fadf/app\\.py') "
                "} | Select-Object -ExpandProperty ProcessId",
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return
    for line in out.splitlines():
        line = line.strip()
        if line.isdigit():
            try:
                os.kill(int(line), 9)
            except OSError:
                pass


def seed_session() -> None:
    settings_path = os.path.join(ROOT, "user-data", "settings.json")
    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    data = {}
    if os.path.isfile(settings_path):
        try:
            data = json.loads(open(settings_path, encoding="utf-8").read())
        except Exception:
            data = {}
    files = [
        os.path.join(ROOT, "app.py"),
        os.path.join(ROOT, "web", "workbench.css"),
    ]
    data["session"] = {
        "root": ROOT,
        "files": files,
        "active": files[0],
    }
    with open(settings_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    try:
        os.remove(UI_REPORT)
    except OSError:
        pass


def test_imports() -> None:
    os.chdir(ROOT)
    sys.path.insert(0, ROOT)
    try:
        import app  # noqa: F401
        import backend  # noqa: F401
        import guard  # noqa: F401
        import piton_jobs  # noqa: F401
        import term  # noqa: F401
        from pitonkit import ask_result  # noqa: F401

        from app import Bridge

        b = Bridge()
        data = b.get_state()
        ok = isinstance(data, dict) and "root" in data
        step("imports", ok, "" if ok else "get_state broken")
    except Exception as exc:
        step("imports", False, str(exc))


def test_piton() -> None:
    os.chdir(ROOT)
    sys.path.insert(0, ROOT)
    try:
        from app import Bridge

        b = Bridge()
        started = b.piton_start(
            {
                "messages": [{"role": "user", "content": "Ответь одним словом: ок"}],
                "skip_cache": False,
            }
        )
        jid = started.get("jobId")
        if not jid:
            step("piton", False, "no jobId")
            return
        t0 = time.time()
        last = {}
        while time.time() - t0 < 25:
            last = b.piton_poll(jid)
            if last.get("done"):
                break
            time.sleep(0.1)
        ok = bool(last.get("done")) and not last.get("error") and bool(str(last.get("reply") or "").strip())
        step(
            "piton",
            ok,
            f"provider={last.get('provider')} reply={str(last.get('reply') or '')[:40]!r} err={last.get('error')}",
        )
    except Exception as exc:
        step("piton", False, str(exc))


def _enum_windows(proc_pid: int) -> list[tuple[int, str]]:
    user32 = ctypes.windll.user32
    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    found: list[tuple[int, str]] = []

    def cb(hwnd, _lparam):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value != proc_pid:
            return True
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        found.append((int(hwnd), buf.value or ""))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return found


def _is_hung(hwnd: int) -> bool:
    try:
        return bool(ctypes.windll.user32.IsHungAppWindow(wintypes.HWND(hwnd)))
    except Exception:
        return False


def _capture(hwnd: int, path: str) -> bool:
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    rect = wintypes.RECT()
    if not user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
        return False
    width = int(rect.right - rect.left)
    height = int(rect.bottom - rect.top)
    if width < 200 or height < 200:
        return False
    hwnd_dc = user32.GetWindowDC(wintypes.HWND(hwnd))
    mem_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bmp = gdi32.CreateCompatibleBitmap(hwnd_dc, width, height)
    gdi32.SelectObject(mem_dc, bmp)
    PW_RENDERFULLCONTENT = 2
    user32.PrintWindow(wintypes.HWND(hwnd), mem_dc, PW_RENDERFULLCONTENT)
    try:
        from PIL import Image
        import ctypes.wintypes as wt

        class BITMAPINFOHEADER(ctypes.Structure):
            _fields_ = [
                ("biSize", wt.DWORD),
                ("biWidth", wt.LONG),
                ("biHeight", wt.LONG),
                ("biPlanes", wt.WORD),
                ("biBitCount", wt.WORD),
                ("biCompression", wt.DWORD),
                ("biSizeImage", wt.DWORD),
                ("biXPelsPerMeter", wt.LONG),
                ("biYPelsPerMeter", wt.LONG),
                ("biClrUsed", wt.DWORD),
                ("biClrImportant", wt.DWORD),
            ]

        class BITMAPINFO(ctypes.Structure):
            _fields_ = [("bmiHeader", BITMAPINFOHEADER)]

        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = width
        info.bmiHeader.biHeight = -height
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        buf = (ctypes.c_ubyte * (width * height * 4))()
        gdi32.GetDIBits(mem_dc, bmp, 0, height, buf, ctypes.byref(info), 0)
        img = Image.frombuffer("RGBA", (width, height), bytes(buf), "raw", "BGRA", 0, 1)
        img.save(path)
        ok = True
    except Exception:
        # fallback: powershell screenshot of bounds
        try:
            subprocess.check_call(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    f"Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
                    f"$b = New-Object System.Drawing.Bitmap {width},{height}; "
                    f"$g = [System.Drawing.Graphics]::FromImage($b); "
                    f"$g.CopyFromScreen({int(rect.left)},{int(rect.top)},0,0,$b.Size); "
                    f"$b.Save('{path.replace(chr(92), chr(92)+chr(92))}'); "
                    f"$g.Dispose(); $b.Dispose()",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            ok = os.path.isfile(path)
        except Exception:
            ok = False
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem_dc)
    user32.ReleaseDC(wintypes.HWND(hwnd), hwnd_dc)
    return ok and os.path.isfile(path)


def test_launch() -> None:
    kill_fadf()
    time.sleep(0.6)
    seed_session()
    proc = subprocess.Popen([PYW, APP, ROOT], cwd=ROOT)
    hwnd = 0
    titles: list[str] = []
    hung = False
    for _ in range(24):
        time.sleep(0.5)
        if proc.poll() is not None:
            break
        wins = _enum_windows(proc.pid)
        titles = [t for _, t in wins]
        forge = [(h, t) for h, t in wins if "Forge Code" in t]
        if forge:
            hwnd = forge[0][0]
            hung = _is_hung(hwnd)
            if hung:
                break
            if os.path.isfile(UI_REPORT):
                break
    alive = proc.poll() is None
    visible_ok = any("Forge Code" in t for t in titles)
    hung = hung or (bool(hwnd) and _is_hung(hwnd))
    step("launch", alive and visible_ok and not hung, f"titles={titles!r} hung={hung}")
    if hwnd and not hung:
        user32 = ctypes.windll.user32
        user32.ShowWindow(hwnd, 9)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.8)
        shot_ok = _capture(hwnd, SCREENSHOT)
        step("screenshot", shot_ok, SCREENSHOT if shot_ok else "no file")
    else:
        step("screenshot", False, "no window")
    report = {}
    if os.path.isfile(UI_REPORT):
        try:
            report = json.loads(open(UI_REPORT, encoding="utf-8").read())
        except Exception as exc:
            step("ui_boot", False, str(exc))
            report = {}
    if report:
        err = bool(report.get("error"))
        status = str(report.get("status") or "")
        tabs = int(report.get("tabCount") or 0)
        names = report.get("tabNames") or []
        bad_status = "is not a function" in status or "не отвечает" in status.lower()
        step(
            "ui_boot",
            bool(report.get("ready")) and not err and not bad_status,
            f"status={status!r} error={err} tabs={tabs} names={names}",
        )
        step("tabs_open", tabs >= 1, f"tabCount={tabs} names={names}")
    else:
        step("ui_boot", False, "no last_ui.json — UI did not boot")
        step("tabs_open", False, "no report")
    if not (alive and visible_ok and not hung):
        try:
            proc.kill()
        except OSError:
            pass


def main() -> int:
    print("=== Forge Code smoke test ===")
    test_imports()
    test_piton()
    test_launch()
    print("===", "ALL PASS" if not fails else f"FAILED: {', '.join(fails)}", "===")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
