from __future__ import annotations

import argparse
import atexit
import functools
import json
import subprocess
import sys
from pathlib import Path

from backend import workspace
from paths import app_dir
from paths import close_native_splash
from paths import resource_dir
from piton import ask
from piton import build_analyze_messages
from piton import build_explain_messages
from piton_jobs import cancel as piton_cancel
from piton_jobs import poll as piton_poll
from piton_jobs import start as piton_start
from term import terminal_manager

HERE = app_dir()
WEB = resource_dir() / "web"


def _patch_webbrowser() -> None:
    import webbrowser

    original = webbrowser.open

    def safe_open(url, new=0, autoraise=True):
        text = str(url or "").strip().lower()
        if not text or text.startswith("about:"):
            return False
        return original(url, new, autoraise)

    webbrowser.open = safe_open
    if hasattr(webbrowser, "open_new"):
        webbrowser.open_new = lambda url: safe_open(url, 1)
    if hasattr(webbrowser, "open_new_tab"):
        webbrowser.open_new_tab = lambda url: safe_open(url, 2)


def _patch_webview2() -> None:
    if sys.platform != "win32":
        return
    try:
        import webview
        from webview.platforms import edgechromium

        _patch_webbrowser()
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = False

        original_ready = edgechromium.EdgeChrome.on_webview_ready

        def on_new_window_request(self, sender, args):
            try:
                args.set_Handled(True)
            except Exception:
                args.Handled = True

        def on_webview_ready(self, sender, args):
            original_ready(self, sender, args)
            if not args.IsSuccess:
                return
            try:
                core = sender.CoreWebView2
                core.Settings.AreBrowserAcceleratorKeysEnabled = False

                def block_new_window(_, event_args):
                    try:
                        event_args.set_Handled(True)
                    except Exception:
                        event_args.Handled = True

                core.NewWindowRequested += block_new_window
            except Exception:
                pass

        edgechromium.EdgeChrome.on_webview_ready = on_webview_ready
        edgechromium.EdgeChrome.on_new_window_request = on_new_window_request
    except Exception:
        pass


class Bridge:
    def __init__(self) -> None:
        # Must stay private: pywebview walks public attrs into the JS API.
        # A public `.window` made it scrape WinForms, hang the UI, and
        # replace `api.state` with a nested object.
        self._window = None

    def get_state(self):
        return workspace.state()

    def ui_report(self, payload=None):
        data = payload if isinstance(payload, dict) else {}
        try:
            path = HERE / "user-data" / "last_ui.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError:
            return {"ok": False}
        return {"ok": True}

    def list_dir(self, path: str = ""):
        return workspace.list_dir(path)

    def tree(self):
        return workspace.list_dir("")

    def read_file(self, path: str):
        return workspace.read_file(path)

    def write_file(self, path: str, content: str):
        return workspace.write_file(path, content)

    def _dialog_path(self, result):
        if not result:
            return None
        if isinstance(result, (list, tuple)):
            return result[0] if result else None
        return str(result)

    def _open_dialog(self, kind, **kwargs):
        import webview

        if not self._window:
            raise RuntimeError("Окно ещё не готово")
        dialog = getattr(webview, "FileDialog", None)
        mapping = {
            "folder": getattr(dialog, "FOLDER", None) if dialog else webview.FOLDER_DIALOG,
            "open": getattr(dialog, "OPEN", None) if dialog else webview.OPEN_DIALOG,
            "save": getattr(dialog, "SAVE", None) if dialog else webview.SAVE_DIALOG,
        }
        mode = mapping[kind]
        try:
            result = self._window.create_file_dialog(mode, **kwargs)
        except Exception:
            return None
        return self._dialog_path(result)

    def pick_folder(self):
        return {"path": self._open_dialog("folder")}

    def pick_file(self):
        return {
            "path": self._open_dialog(
                "open",
                allow_multiple=False,
                file_types=("Python (*.py;*.pyw)", "Text (*.txt;*.md)", "All files (*.*)"),
            )
        }

    def pick_save_path(self, initial: str = ""):
        from pathlib import Path

        name = "untitled.py"
        directory = ""
        if initial and not str(initial).startswith("untitled:"):
            start = Path(initial)
            name = start.name or name
            if start.parent.exists():
                directory = str(start.parent)
        return {
            "path": self._open_dialog(
                "save",
                directory=directory,
                save_filename=name,
                file_types=("Python (*.py;*.pyw)", "Text (*.txt;*.md)", "All files (*.*)"),
            )
        }

    def open_folder(self, path: str):
        return {"path": workspace.set_root(path)}

    def close_folder(self):
        workspace.set_root(None)
        return {"ok": True}

    def save_session(self, payload=None):
        return workspace.save_session(payload if isinstance(payload, dict) else {})

    def create_entry(self, relative: str, kind: str):
        return workspace.create_entry(relative, kind)

    def list_files(self, query: str = ""):
        return workspace.list_files(query or "")

    def search_files(self, query: str = ""):
        return workspace.search_files(query or "")

    def rename_entry(self, path: str, new_name: str):
        return workspace.rename_entry(path, new_name)

    def delete_entry(self, path: str):
        return workspace.delete_entry(path)

    def diagnose(self, path: str, content: str):
        return {"problems": workspace.diagnose(path, content)}

    def run_file(self, path: str):
        return workspace.run_file(path)

    def run_command(self, command: str):
        return workspace.run_command(command)

    def _term_defaults(self):
        return {
            "cwd": workspace.state()["root"],
            "shell": workspace.settings.get("shell") or "powershell",
        }

    def term_create(self, cols: int = 120, rows: int = 24):
        defaults = self._term_defaults()
        return terminal_manager.create(
            defaults["cwd"],
            int(cols),
            int(rows),
            defaults["shell"],
        )

    def term_close(self, session_id: str):
        return {"ok": terminal_manager.close(str(session_id or ""))}

    def update_settings(self, payload: dict):
        previous_shell = workspace.settings.get("shell")
        data = workspace.update_settings(payload or {})
        if data.get("shell") != previous_shell:
            terminal_manager.restart_all(
                data.get("root"),
                120,
                24,
                data.get("shell") or "powershell",
            )
        return data

    def term_write(self, session_id: str, data: str):
        return {"ok": terminal_manager.write(str(session_id or ""), data or "")}

    def term_poll(self, session_id: str):
        return {"data": terminal_manager.poll(str(session_id or ""))}

    def term_resize(self, session_id: str, cols: int, rows: int):
        terminal_manager.resize(str(session_id or ""), int(cols), int(rows))
        return {"ok": True}

    def term_cd(self, session_id: str, path: str):
        terminal_manager.cd(str(session_id or ""), path or "")
        return {"ok": True}

    def term_run_python(self, session_id: str, path: str, args: str = ""):
        sid = str(session_id or "")
        defaults = self._term_defaults()
        sid = terminal_manager.ensure(sid, defaults["cwd"], 120, 24, defaults["shell"])
        run_args = str(args if args is not None else workspace.settings.get("runArgs") or "")
        terminal_manager.run_python(sid, path, run_args)
        return {"ok": True, "sessionId": sid}

    def term_interrupt(self, session_id: str):
        sid = str(session_id or "")
        return {"ok": terminal_manager.interrupt(sid)}

    def set_auto_save(self, enabled: bool):
        return workspace.set_auto_save(enabled)

    def piton_start(self, messages: list, skip_cache: bool = False):
        # pywebview иногда криво передаёт лишние позиционные args — нормализуем.
        payload = messages
        skip = skip_cache
        if isinstance(messages, dict):
            payload = messages.get("messages") or []
            skip = bool(messages.get("skip_cache", skip_cache))
        job_id = piton_start(payload if isinstance(payload, list) else [], skip_cache=bool(skip))
        return {"jobId": job_id}

    def piton_poll(self, job_id: str):
        return piton_poll(str(job_id or ""))

    def piton_cancel(self, job_id: str):
        return piton_cancel(str(job_id or ""))

    def piton_analyze_code(self, code: str, filename: str = "", language: str = "", skip_cache: bool = False):
        if isinstance(code, dict):
            payload = code
            code = str(payload.get("code") or "")
            filename = str(payload.get("filename") or filename or "")
            language = str(payload.get("language") or language or "")
            skip_cache = bool(payload.get("skip_cache", skip_cache))
        messages = build_analyze_messages(
            str(code or ""),
            filename=str(filename or ""),
            language=str(language or ""),
        )
        job_id = piton_start(messages, skip_cache=bool(skip_cache))
        return {"jobId": job_id}

    def piton_explain_error(self, text: str, filename: str = "", skip_cache: bool = False):
        if isinstance(text, dict):
            payload = text
            text = str(payload.get("text") or "")
            filename = str(payload.get("filename") or filename or "")
            skip_cache = bool(payload.get("skip_cache", skip_cache))
        messages = build_explain_messages(str(text or ""), filename=str(filename or ""))
        job_id = piton_start(messages, skip_cache=bool(skip_cache))
        return {"jobId": job_id}

    def new_window(self):
        if getattr(sys, "frozen", False):
            subprocess.Popen([sys.executable], cwd=str(HERE))
        else:
            pythonw = Path(sys.executable).with_name("pythonw.exe")
            exe = str(pythonw if pythonw.exists() else sys.executable)
            subprocess.Popen([exe, str(HERE / "app.py")], cwd=str(HERE))
        return {"ok": True}

    def quit(self):
        terminal_manager.stop_all()
        if self._window is not None:
            self._window.destroy()
        return {"ok": True}

    def window_minimize(self):
        if self._window is not None:
            self._window.minimize()
        return {"ok": True}

    def window_toggle_maximize(self):
        if self._window is None:
            return {"ok": False}
        try:
            if bool(getattr(self._window, "maximized", False)):
                self._window.restore()
            else:
                self._window.maximize()
        except Exception:
            try:
                self._window.toggle_fullscreen()
            except Exception:
                pass
        return {"ok": True}

    def window_close(self):
        return self.quit()

    def set_window_title(self, title: str = ""):
        # Empty titles crash pywebview/WebView2 (infinite Empty.Empty... recursion).
        text = str(title or "").strip() or "\u00a0"
        if self._window is not None:
            try:
                self._window.set_title(text)
            except Exception:
                try:
                    self._window.title = text
                except Exception:
                    pass
        return {"ok": True}


def _guard_bridge_method(fn):
    @functools.wraps(fn)
    def wrapped(self, *args, **kwargs):
        try:
            return fn(self, *args, **kwargs)
        except Exception as exc:
            try:
                from guard import log_exception

                log_exception(f"Bridge.{fn.__name__}", exc)
            except Exception:
                pass
            raise

    return wrapped


for _name, _attr in list(Bridge.__dict__.items()):
    if _name.startswith("_") or not callable(_attr):
        continue
    setattr(Bridge, _name, _guard_bridge_method(_attr))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Forge Code")
    parser.add_argument("folder", nargs="?", help="Папка проекта")
    return parser.parse_args(argv)


def _activate_existing_window() -> bool:
    """Bring an already-running Forge Code window to the front."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    targets: list[int] = []

    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value or ""
        if (
            title == "Forge Code"
            or title.endswith(" — Forge Code")
            or "Forge Code" in title
            or title == "\u00a0"
        ):
            try:
                if user32.IsHungAppWindow(wintypes.HWND(int(hwnd))):
                    return True
            except Exception:
                pass
            targets.append(int(hwnd))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    if not targets:
        return False
    hwnd = targets[0]
    SW_RESTORE = 9
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)
    return True


def _kill_stale_app_processes() -> int:
    """Kill pythonw instances of fadf/app.py that hold the mutex but have no usable window."""
    import os

    killed = 0
    me = os.getpid()
    try:
        import subprocess

        out = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process "
                "| Where-Object { "
                "    ($_.Name -match '^python(w)?\\.exe$') -and "
                "    ($_.CommandLine -match 'fadf\\\\app\\.py|fadf/app\\.py') "
                "} | Select-Object -ExpandProperty ProcessId",
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return 0
    for line in out.splitlines():
        line = line.strip()
        if not line.isdigit():
            continue
        pid = int(line)
        if pid == me:
            continue
        try:
            os.kill(pid, 9)
            killed += 1
        except OSError:
            pass
    return killed


def _ensure_single_instance() -> None:
    if sys.platform != "win32":
        return
    import ctypes
    import time

    kernel32 = ctypes.windll.kernel32
    ERROR_ALREADY_EXISTS = 183
    mutex_name = "Local\\ForgeCode.SingleInstance"
    mutex = kernel32.CreateMutexW(None, False, mutex_name)
    if kernel32.GetLastError() != ERROR_ALREADY_EXISTS:
        return
    if _activate_existing_window():
        raise SystemExit(0)
    # Зависший процесс без нормального окна — убираем и стартуем заново.
    killed = _kill_stale_app_processes()
    if killed:
        time.sleep(0.5)
        mutex = kernel32.CreateMutexW(None, False, mutex_name)
        if kernel32.GetLastError() != ERROR_ALREADY_EXISTS:
            return
    ctypes.windll.user32.MessageBoxW(
        0,
        "Forge Code уже запущен, но окно не удалось открыть.\n"
        "Закрой pythonw.exe в Диспетчере задач и запусти снова.",
        "Forge Code",
        0x30,
    )
    raise SystemExit(0)


def _hwnd_from_window(window) -> int | None:
    native = getattr(window, "native", None)
    if native is None:
        return None
    handle = getattr(native, "Handle", None)
    if handle is None:
        return None
    try:
        return int(handle.ToInt32()) if hasattr(handle, "ToInt32") else int(handle)
    except Exception:
        try:
            return int(handle)
        except Exception:
            return None


def _apply_window_rounding(window, radius: int = 12) -> None:
    """Round OS window corners (Win11 DWM + region fallback)."""
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    hwnd = _hwnd_from_window(window)
    if not hwnd:
        return

    # Windows 11 rounded corners
    DWMWA_WINDOW_CORNER_PREFERENCE = 33
    DWMWCP_ROUND = 2
    preference = ctypes.c_int(DWMWCP_ROUND)
    try:
        ctypes.windll.dwmapi.DwmSetWindowAttribute(
            wintypes.HWND(hwnd),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            ctypes.byref(preference),
            ctypes.sizeof(preference),
        )
    except Exception:
        pass

    # Do not SetWindowRgn here: it deadlocks WebView2 + frameless WinForms.


def main(argv: list[str] | None = None) -> None:
    from guard import install

    install()
    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("ForgeCode.App")
        except Exception:
            pass
    args = parse_args(argv or sys.argv[1:])
    if args.folder:
        workspace.set_root(args.folder)
    _ensure_single_instance()
    try:
        import webview
    except ImportError:
        raise SystemExit("Не установлен pywebview. В папке проекта выполни: pip install -r requirements.txt")
    bridge = Bridge()
    _patch_webview2()
    close_native_splash()
    window = webview.create_window(
        "Forge Code",
        str(WEB / "index.html"),
        js_api=bridge,
        width=1280,
        height=820,
        min_size=(900, 560),
        background_color="#1e1e1e",
        text_select=True,
        frameless=True,
        easy_drag=False,
    )
    bridge._window = window

    def _on_shown():
        try:
            window.set_title("Forge Code")
        except Exception:
            pass
        try:
            window.restore()
        except Exception:
            pass
        try:
            window.show()
        except Exception:
            pass
        try:
            _apply_window_rounding(window, radius=12)
        except Exception:
            pass

    try:
        window.events.shown += _on_shown
    except Exception:
        pass

    def _on_closing():
        try:
            terminal_manager.stop_all()
        except Exception:
            pass

    try:
        window.events.closing += _on_closing
    except Exception:
        pass
    storage = HERE / "user-data" / "webview2"
    try:
        storage.mkdir(parents=True, exist_ok=True)
    except OSError:
        storage = HERE / "user-data"
    atexit.register(terminal_manager.stop_all)
    webview.start(
        gui="edgechromium" if sys.platform == "win32" else None,
        private_mode=False,
        storage_path=str(storage),
        http_server=True,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback

        text = traceback.format_exc()
        try:
            (HERE / "crash.log").write_text(text, encoding="utf-8")
        except OSError:
            pass
        try:
            import tkinter as tk
            from tkinter import messagebox

            root = tk.Tk()
            root.withdraw()
            messagebox.showerror("Forge Code", "Не удалось запустить:\n\n" + text[-1500:])
            root.destroy()
        except Exception:
            pass
        raise
