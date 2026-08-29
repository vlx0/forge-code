"""Crash logging and process-level hardening. Not used by Piton."""
from __future__ import annotations

import faulthandler
import os
import sys
import threading
import traceback
from pathlib import Path

from paths import app_dir

CRASH_LOG = app_dir() / "crash.log"
_fault_file = None


def _append(text: str) -> None:
    try:
        CRASH_LOG.parent.mkdir(parents=True, exist_ok=True)
        with CRASH_LOG.open("a", encoding="utf-8") as fh:
            fh.write(text)
            if not text.endswith("\n"):
                fh.write("\n")
    except OSError:
        pass


def log_exception(where: str, exc: BaseException | None = None) -> None:
    if exc is None:
        _append(f"\n--- {where} ---\n{traceback.format_exc()}")
        return
    _append(f"\n--- {where}: {type(exc).__name__}: {exc} ---\n{traceback.format_exc()}")


def install() -> None:
    global _fault_file
    if sys.platform == "win32":
        try:
            import ctypes

            # Don't freeze the editor behind Windows "program has stopped working" boxes.
            SEM_FAILCRITICALERRORS = 0x0001
            SEM_NOGPFAULTERRORBOX = 0x0002
            SEM_NOOPENFILEERRORBOX = 0x8000
            ctypes.windll.kernel32.SetErrorMode(
                SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX
            )
        except Exception:
            pass
    try:
        CRASH_LOG.parent.mkdir(parents=True, exist_ok=True)
        _fault_file = CRASH_LOG.open("a", encoding="utf-8")
        faulthandler.enable(file=_fault_file, all_threads=True)
    except OSError:
        try:
            faulthandler.enable(all_threads=True)
        except Exception:
            pass

    def _hook(exc_type, exc, tb) -> None:
        try:
            _append("\n--- sys.excepthook ---\n" + "".join(traceback.format_exception(exc_type, exc, tb)))
        except Exception:
            pass
        sys.__excepthook__(exc_type, exc, tb)

    sys.excepthook = _hook

    def _thread_hook(args: threading.ExceptHookArgs) -> None:
        if args.exc_type is SystemExit:
            return
        log_exception(f"thread {args.thread.name if args.thread else '?'}", args.exc_value)

    threading.excepthook = _thread_hook
    os.environ.setdefault("PYTHONUTF8", "1")
