from __future__ import annotations

import os
import queue
import shutil
import threading
import uuid
from pathlib import Path

from winpty import PtyProcess

MAX_SESSIONS = 6
MAX_QUEUE = 120
MAX_POLL_CHARS = 48_000


class LiveTerminal:
    def __init__(self) -> None:
        self._proc: PtyProcess | None = None
        self._thread: threading.Thread | None = None
        self._out: queue.Queue[str] = queue.Queue(maxsize=MAX_QUEUE)
        self._lock = threading.Lock()
        self.shell = "powershell"
        self.cwd = str(Path.home())

    def start(self, cwd: str | None = None, cols: int = 120, rows: int = 24, shell_name: str = "powershell") -> dict:
        self.stop()
        folder = cwd or str(Path.home())
        try:
            folder_path = Path(folder)
            if not folder_path.is_dir():
                folder = str(Path.home())
        except OSError:
            folder = str(Path.home())
        self.cwd = folder
        choice = (shell_name or "powershell").lower()
        if choice == "cmd":
            shell = shutil.which("cmd")
        elif choice == "pwsh":
            shell = shutil.which("pwsh") or shutil.which("powershell")
        else:
            shell = shutil.which("powershell") or shutil.which("pwsh") or shutil.which("cmd")
        if not shell:
            raise RuntimeError("Не найден PowerShell или cmd")
        self.shell = Path(shell).stem.lower()
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        try:
            proc = PtyProcess.spawn(
                shell,
                cwd=folder,
                env=env,
                dimensions=(max(8, rows), max(20, cols)),
            )
        except Exception as exc:
            raise RuntimeError(f"Не удалось запустить терминал: {exc}") from exc
        with self._lock:
            self._proc = proc
        thread = threading.Thread(target=self._read_loop, args=(proc,), daemon=True, name="fc-pty")
        thread.start()
        self._thread = thread
        return {"ok": True, "shell": shell, "cwd": folder}

    def write(self, data: str) -> bool:
        with self._lock:
            proc = self._proc
        if proc is None:
            return False
        try:
            if not proc.isalive():
                return False
            proc.write(data)
            return True
        except Exception:
            return False

    def poll(self) -> str:
        chunks: list[str] = []
        total = 0
        while True:
            try:
                piece = self._out.get_nowait()
            except queue.Empty:
                break
            chunks.append(piece)
            total += len(piece)
            if total >= MAX_POLL_CHARS:
                break
        text = "".join(chunks)
        if len(text) > MAX_POLL_CHARS:
            return text[-MAX_POLL_CHARS:]
        return text

    def resize(self, cols: int, rows: int) -> None:
        with self._lock:
            proc = self._proc
        if proc is None:
            return
        try:
            if not proc.isalive():
                return
            proc.setwinsize(max(8, int(rows)), max(20, int(cols)))
        except Exception:
            pass

    def cd(self, path: str) -> None:
        if not path:
            return
        self.cwd = path
        if self.shell in {"powershell", "pwsh"}:
            escaped = path.replace("'", "''")
            self.write(f"Set-Location -LiteralPath '{escaped}'\r")
        else:
            self.write(f'cd /d "{path}"\r')

    def run_python(self, path: str, args: str = "") -> None:
        escaped = path.replace("'", "''")
        extra = (args or "").strip()
        if extra:
            self.write(f"python -u '{escaped}' {extra}\r")
        else:
            self.write(f"python -u '{escaped}'\r")

    def interrupt(self) -> None:
        self.write("\x03")

    def alive(self) -> bool:
        with self._lock:
            proc = self._proc
        if proc is None:
            return False
        try:
            return bool(proc.isalive())
        except Exception:
            return False

    def stop(self) -> None:
        with self._lock:
            proc = self._proc
            self._proc = None
        if proc is None:
            return
        try:
            proc.terminate(force=True)
        except Exception:
            try:
                proc.kill(9)
            except Exception:
                pass

    def _push(self, data: str) -> None:
        try:
            self._out.put_nowait(data)
            return
        except queue.Full:
            pass
        try:
            self._out.get_nowait()
        except queue.Empty:
            pass
        try:
            self._out.put_nowait(data)
        except queue.Full:
            pass

    def _read_loop(self, proc: PtyProcess) -> None:
        while True:
            try:
                data = proc.read(4096)
            except EOFError:
                break
            except Exception:
                break
            if data:
                self._push(data)
            try:
                if not proc.isalive():
                    break
            except Exception:
                break
        self._push("\r\n[терминал завершён]\r\n")


class TerminalManager:
    def __init__(self) -> None:
        self._sessions: dict[str, LiveTerminal] = {}
        self._lock = threading.Lock()

    def create(self, cwd: str | None = None, cols: int = 120, rows: int = 24, shell_name: str = "powershell") -> dict:
        with self._lock:
            if len(self._sessions) >= MAX_SESSIONS:
                oldest = next(iter(self._sessions), None)
                extra = self._sessions.pop(oldest, None) if oldest else None
            else:
                extra = None
        if extra is not None:
            extra.stop()
        session_id = uuid.uuid4().hex[:8]
        term = LiveTerminal()
        info = term.start(cwd, cols, rows, shell_name)
        with self._lock:
            self._sessions[session_id] = term
        return {"sessionId": session_id, **info}

    def _get(self, session_id: str) -> LiveTerminal | None:
        if not session_id:
            return None
        with self._lock:
            return self._sessions.get(session_id)

    def close(self, session_id: str) -> bool:
        with self._lock:
            term = self._sessions.pop(session_id, None)
        if term is None:
            return False
        term.stop()
        return True

    def write(self, session_id: str, data: str) -> bool:
        term = self._get(session_id)
        if term is None:
            return False
        return term.write(data or "")

    def poll(self, session_id: str) -> str:
        term = self._get(session_id)
        if term is None:
            return ""
        return term.poll()

    def resize(self, session_id: str, cols: int, rows: int) -> None:
        term = self._get(session_id)
        if term is None:
            return
        term.resize(cols, rows)

    def cd(self, session_id: str, path: str) -> None:
        term = self._get(session_id)
        if term is None:
            return
        term.cd(path or "")

    def cd_all(self, path: str) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
        for term in sessions:
            if term.alive():
                term.cd(path or "")

    def run_python(self, session_id: str, path: str, args: str = "") -> bool:
        term = self._get(session_id)
        if term is None:
            return False
        if not term.alive():
            return False
        term.run_python(path, args)
        return True

    def interrupt(self, session_id: str) -> bool:
        term = self._get(session_id)
        if term is None:
            return False
        term.interrupt()
        return True

    def ensure(self, session_id: str, cwd: str | None, cols: int, rows: int, shell_name: str) -> str:
        term = self._get(session_id)
        if term is None:
            created = self.create(cwd, cols, rows, shell_name)
            return str(created["sessionId"])
        if not term.alive():
            try:
                term.start(cwd or term.cwd, cols, rows, shell_name)
            except Exception:
                created = self.create(cwd, cols, rows, shell_name)
                return str(created["sessionId"])
        return session_id

    def restart_all(self, cwd: str | None, cols: int, rows: int, shell_name: str) -> None:
        with self._lock:
            ids = list(self._sessions.keys())
        for session_id in ids:
            term = self._get(session_id)
            if term is None:
                continue
            folder = cwd or term.cwd
            try:
                term.start(folder, cols, rows, shell_name)
            except Exception:
                self.close(session_id)

    def stop_all(self) -> None:
        with self._lock:
            ids = list(self._sessions.keys())
        for session_id in ids:
            self.close(session_id)


terminal_manager = TerminalManager()

# Backward-compatible alias for any legacy imports
terminal = terminal_manager
