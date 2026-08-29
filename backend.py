from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

from paths import app_dir

IGNORE_DIRS = {
    ".git",
    "__pycache__",
    ".venv",
    "venv",
    "node_modules",
    ".idea",
    ".vscode",
    "user-data",
    "webview2",
}
DATA_DIR = app_dir() / "user-data"
SETTINGS_FILE = DATA_DIR / "settings.json"
_SETTINGS_LOCK = threading.Lock()
MAX_FILE_BYTES = 1_000_000

LANGUAGE_BY_EXT = {
    ".py": "python",
    ".pyw": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".jsx": "javascript",
    ".json": "json",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".md": "markdown",
    ".xml": "xml",
    ".svg": "xml",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "ini",
    ".ini": "ini",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".sh": "shell",
    ".ps1": "powershell",
    ".bat": "bat",
}
DEFAULT_SETTINGS = {
    "autoSave": False,
    "recent": [],
    "recentFiles": [],
    "fontFamily": "Consolas, 'Cascadia Mono', monospace",
    "fontSize": 14,
    "theme": "dark",
    "shell": "powershell",
    "runArgs": "",
    "session": {"root": None, "files": [], "active": None},
}

SKIP_SEARCH_EXT = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".bmp",
    ".exe",
    ".dll",
    ".so",
    ".pyc",
    ".pyo",
    ".zip",
    ".7z",
    ".rar",
    ".pdf",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".mp3",
    ".mp4",
    ".wasm",
}
MAX_INDEX_FILES = 4000
MAX_SEARCH_HITS = 80
MAX_SEARCH_FILE_BYTES = 400_000

PYTHON_FILE_TEMPLATE = '''def main():
    pass


if __name__ == "__main__":
    main()
'''


def load_settings() -> dict:
    settings = dict(DEFAULT_SETTINGS)
    if not SETTINGS_FILE.exists():
        return settings
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            settings.update(data)
    except (OSError, json.JSONDecodeError):
        pass
    settings.setdefault("autoSave", False)
    settings.setdefault("recent", [])
    settings.setdefault("recentFiles", [])
    settings.setdefault("runArgs", "")
    session = settings.get("session")
    if not isinstance(session, dict):
        settings["session"] = dict(DEFAULT_SETTINGS["session"])
    else:
        settings["session"] = {
            "root": session.get("root") or None,
            "files": [str(item) for item in (session.get("files") or []) if item],
            "active": session.get("active") or None,
        }
    settings.pop("pitonBackend", None)
    settings.pop("ollamaUrl", None)
    settings.pop("ollamaModel", None)
    return settings


def save_settings(settings: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(settings, ensure_ascii=False, indent=2)
    tmp = SETTINGS_FILE.with_name(SETTINGS_FILE.name + ".tmp")
    with _SETTINGS_LOCK:
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, SETTINGS_FILE)


class FolderPicker:
    """Tkinter dialogs must run on a dedicated thread with a live mainloop."""

    def __init__(self) -> None:
        self._jobs: queue.Queue = queue.Queue()
        self._ready = threading.Event()
        thread = threading.Thread(target=self._loop, name="folder-picker", daemon=True)
        thread.start()
        if not self._ready.wait(timeout=8):
            raise RuntimeError("Не удалось запустить диалог выбора папки")

    def _loop(self) -> None:
        import tkinter as tk
        from tkinter import filedialog

        ui = tk.Tk()
        ui.withdraw()
        try:
            ui.attributes("-topmost", True)
        except tk.TclError:
            pass
        self._ui = ui
        self._dialog = filedialog
        self._ready.set()

        def poll() -> None:
            try:
                job, reply = self._jobs.get_nowait()
            except queue.Empty:
                ui.after(40, poll)
                return
            try:
                reply.put(("ok", job()))
            except Exception as exc:
                reply.put(("err", exc))
            ui.after(40, poll)

        ui.after(40, poll)
        ui.mainloop()

    def ask_directory(self) -> str | None:
        reply: queue.Queue = queue.Queue()

        def job() -> str | None:
            chosen = self._dialog.askdirectory(parent=self._ui, title="Открыть папку")
            return chosen or None

        self._jobs.put((job, reply))
        status, value = reply.get()
        if status == "err":
            raise value
        return value

    def ask_open_file(self) -> str | None:
        reply: queue.Queue = queue.Queue()

        def job() -> str | None:
            chosen = self._dialog.askopenfilename(
                parent=self._ui,
                title="Открыть файл",
                filetypes=[("Все файлы", "*.*"), ("Python", "*.py *.pyw"), ("Текст", "*.txt *.md")],
            )
            return chosen or None

        self._jobs.put((job, reply))
        status, value = reply.get()
        if status == "err":
            raise value
        return value

    def ask_save_file(self, initial: str = "") -> str | None:
        reply: queue.Queue = queue.Queue()
        start = Path(initial) if initial else None

        def job() -> str | None:
            kwargs = {
                "parent": self._ui,
                "title": "Сохранить как",
                "filetypes": [("Все файлы", "*.*"), ("Python", "*.py *.pyw"), ("Текст", "*.txt *.md")],
                "defaultextension": ".py",
            }
            if start:
                if start.parent.is_dir():
                    kwargs["initialdir"] = str(start.parent)
                kwargs["initialfile"] = start.name
            chosen = self._dialog.asksaveasfilename(**kwargs)
            return chosen or None

        self._jobs.put((job, reply))
        status, value = reply.get()
        if status == "err":
            raise value
        return value


class Workspace:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.root: Path | None = None
        self._picker: FolderPicker | None = None
        self.settings = load_settings()
        self._file_index: list[Path] | None = None
        self._file_index_root: Path | None = None

    def _picker_obj(self) -> FolderPicker:
        if self._picker is None:
            self._picker = FolderPicker()
        return self._picker

    def _invalidate_file_index(self) -> None:
        with self._lock:
            self._file_index = None
            self._file_index_root = None

    def set_root(self, path: str | os.PathLike[str] | None) -> str | None:
        if not path:
            with self._lock:
                self.root = None
            self._invalidate_file_index()
            return None
        resolved = Path(path).expanduser().resolve()
        if not resolved.is_dir():
            raise FileNotFoundError(f"Папка не найдена: {resolved}")
        with self._lock:
            self.root = resolved
        self._invalidate_file_index()
        self.remember_folder(str(resolved))
        return str(resolved)

    def remember_folder(self, path: str) -> None:
        recent = [item for item in self.settings.get("recent", []) if item != path]
        recent.insert(0, path)
        self.settings["recent"] = recent[:12]
        save_settings(self.settings)

    def remember_file(self, path: str) -> None:
        resolved = str(self._abs_path(path))
        recent = [item for item in self.settings.get("recentFiles", []) if item != resolved]
        recent.insert(0, resolved)
        self.settings["recentFiles"] = recent[:20]
        save_settings(self.settings)

    def set_auto_save(self, enabled: bool) -> dict:
        self.settings["autoSave"] = bool(enabled)
        save_settings(self.settings)
        return {"autoSave": self.settings["autoSave"]}

    def save_session(self, payload: dict | None = None) -> dict:
        data = payload if isinstance(payload, dict) else {}
        root = data.get("root") or None
        if root:
            root = str(Path(str(root)).expanduser())
            if not Path(root).is_dir():
                root = None
        files: list[str] = []
        seen: set[str] = set()
        for item in data.get("files") or []:
            path = str(item or "").strip()
            if not path or path.startswith("untitled:") or path in seen:
                continue
            try:
                resolved = str(Path(path).expanduser().resolve())
            except OSError:
                continue
            if not Path(resolved).is_file():
                continue
            seen.add(path)
            seen.add(resolved)
            files.append(resolved)
        active = data.get("active") or None
        if active:
            active = str(active)
            if active.startswith("untitled:"):
                active = None
            else:
                try:
                    active = str(Path(active).expanduser().resolve())
                except OSError:
                    active = None
            if active not in files:
                active = files[-1] if files else None
        session = {"root": root, "files": files[:12], "active": active}
        self.settings["session"] = session
        save_settings(self.settings)
        return {"session": session}

    def update_settings(self, payload: dict) -> dict:
        if not isinstance(payload, dict):
            raise ValueError("Некорректные настройки")
        if "fontFamily" in payload and str(payload["fontFamily"]).strip():
            self.settings["fontFamily"] = str(payload["fontFamily"]).strip()
        if "fontSize" in payload:
            size = int(payload["fontSize"])
            self.settings["fontSize"] = min(32, max(10, size))
        if payload.get("theme") in {"dark", "light", "hc"}:
            self.settings["theme"] = payload["theme"]
        if payload.get("shell") in {"powershell", "pwsh", "cmd"}:
            self.settings["shell"] = payload["shell"]
        if "autoSave" in payload:
            self.settings["autoSave"] = bool(payload["autoSave"])
        if "runArgs" in payload:
            self.settings["runArgs"] = str(payload["runArgs"] or "")
        save_settings(self.settings)
        return self.state()

    def pick_folder(self) -> str | None:
        return self._picker_obj().ask_directory()

    def pick_file(self) -> str | None:
        return self._picker_obj().ask_open_file()

    def pick_save_path(self, initial: str = "") -> str | None:
        return self._picker_obj().ask_save_file(initial)

    def state(self) -> dict:
        with self._lock:
            root = self.root
        session = self.settings.get("session") if isinstance(self.settings.get("session"), dict) else {}
        return {
            "root": str(root) if root else None,
            "name": root.name if root else None,
            "autoSave": bool(self.settings.get("autoSave")),
            "recent": list(self.settings.get("recent") or []),
            "recentFiles": list(self.settings.get("recentFiles") or []),
            "fontFamily": self.settings.get("fontFamily") or DEFAULT_SETTINGS["fontFamily"],
            "fontSize": int(self.settings.get("fontSize") or 14),
            "theme": self.settings.get("theme") or "dark",
            "shell": self.settings.get("shell") or "powershell",
            "runArgs": self.settings.get("runArgs") or "",
            "session": {
                "root": session.get("root") or None,
                "files": list(session.get("files") or []),
                "active": session.get("active") or None,
            },
        }

    def list_dir(self, path: str = "") -> dict:
        folder = self._require_root() if not path else self._safe_path(path)
        if not folder.is_dir():
            raise NotADirectoryError("Это не папка")
        dirs: list[dict] = []
        files: list[dict] = []
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    if entry.name in IGNORE_DIRS:
                        continue
                    try:
                        is_dir = entry.is_dir(follow_symlinks=False)
                    except OSError:
                        continue
                    try:
                        resolved = Path(entry.path).resolve()
                    except OSError:
                        continue
                    if is_dir:
                        dirs.append(
                            {
                                "name": entry.name,
                                "path": str(resolved),
                                "type": "dir",
                            }
                        )
                    else:
                        files.append(
                            {
                                "name": entry.name,
                                "path": str(resolved),
                                "type": "file",
                                "language": language_for(resolved),
                            }
                        )
        except OSError:
            pass
        dirs.sort(key=lambda item: item["name"].lower())
        files.sort(key=lambda item: item["name"].lower())
        children = dirs + files
        if len(children) > 1500:
            children = children[:1500]
        return {
            "name": folder.name,
            "path": str(folder),
            "type": "dir",
            "children": children,
        }

    def tree(self) -> dict:
        return self.list_dir("")

    def read_file(self, path: str) -> dict:
        target = self._abs_path(path)
        if not target.is_file():
            raise FileNotFoundError("Файл не найден")
        if target.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("Файл слишком большой для редактора")
        try:
            text = read_text_file(target)
        except UnicodeDecodeError as exc:
            raise ValueError("Бинарный файл нельзя открыть как текст") from exc
        self.remember_file(str(target))
        return {
            "path": str(target),
            "content": text,
            "language": language_for(target),
        }

    def write_file(self, path: str, content: str) -> dict:
        target = self._abs_path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        last_error: OSError | None = None
        for _ in range(4):
            try:
                target.write_text(content, encoding="utf-8", newline="\n")
                last_error = None
                break
            except OSError as exc:
                last_error = exc
                time.sleep(0.12)
        if last_error is not None:
            raise last_error
        return {"path": str(target), "ok": True, "language": language_for(target)}

    def create_entry(self, relative: str, kind: str) -> dict:
        root = self._require_root()
        relative = relative.replace("\\", "/").strip("/")
        if not relative or ".." in Path(relative).parts:
            raise ValueError("Некорректный путь")
        target = self._safe_path(root / relative)
        if kind == "dir":
            target.mkdir(parents=True, exist_ok=False)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                raise FileExistsError("Уже существует")
            if target.suffix.lower() in {".py", ".pyw"}:
                target.write_text(PYTHON_FILE_TEMPLATE, encoding="utf-8", newline="\n")
            else:
                target.write_text("", encoding="utf-8")
        return {"path": str(target), "type": kind}

    def _iter_project_files(self, *, deadline: float | None = None):
        root = self._require_root()
        count = 0
        for dirpath, dirnames, filenames in os.walk(root):
            if deadline is not None and time.monotonic() > deadline:
                return
            dirnames[:] = [name for name in dirnames if name not in IGNORE_DIRS and not name.startswith(".")]
            for name in filenames:
                if deadline is not None and time.monotonic() > deadline:
                    return
                if count >= MAX_INDEX_FILES:
                    return
                path = Path(dirpath) / name
                if path.suffix.lower() in SKIP_SEARCH_EXT:
                    continue
                try:
                    if not path.is_file():
                        continue
                    resolved = path.resolve()
                except OSError:
                    continue
                count += 1
                yield resolved

    def _cached_project_files(self) -> list[Path]:
        root = self._require_root()
        with self._lock:
            if self._file_index is not None and self._file_index_root == root:
                return list(self._file_index)
        files = list(self._iter_project_files(deadline=time.monotonic() + 0.4))
        with self._lock:
            self._file_index = files
            self._file_index_root = root
        return files

    def list_files(self, query: str = "") -> dict:
        root = self._require_root()
        q = str(query or "").strip().lower().replace("\\", "/")
        files = []
        for path in self._cached_project_files():
            rel = path.relative_to(root).as_posix()
            name = path.name
            if q and q not in name.lower() and q not in rel.lower():
                continue
            files.append(
                {
                    "name": name,
                    "path": str(path),
                    "relative": rel,
                    "language": language_for(path),
                }
            )
            if len(files) >= 80:
                break
        return {"files": files, "root": str(root)}

    def search_files(self, query: str) -> dict:
        root = self._require_root()
        q = str(query or "").strip()
        if len(q) < 2:
            return {"hits": [], "root": str(root)}
        needle = q.lower()
        hits = []
        deadline = time.monotonic() + 0.8
        for path in self._cached_project_files():
            if time.monotonic() > deadline:
                break
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size > MAX_SEARCH_FILE_BYTES:
                continue
            try:
                text = read_text_file(path)
            except (OSError, UnicodeDecodeError, ValueError):
                continue
            rel = path.relative_to(root).as_posix()
            for index, line in enumerate(text.splitlines(), start=1):
                if needle not in line.lower():
                    continue
                hits.append(
                    {
                        "path": str(path),
                        "relative": rel,
                        "name": path.name,
                        "line": index,
                        "preview": line.strip()[:160],
                    }
                )
                if len(hits) >= MAX_SEARCH_HITS:
                    return {"hits": hits, "root": str(root)}
            if time.monotonic() > deadline:
                break
        return {"hits": hits, "root": str(root)}

    def _resolve_tree_path(self, path: str) -> Path:
        target = self._abs_path(path)
        with self._lock:
            root = self.root
        if root is not None:
            root = root.resolve()
            if target != root and root not in target.parents:
                raise PermissionError("Путь вне открытой папки")
        return target

    def rename_entry(self, path: str, new_name: str) -> dict:
        name = str(new_name or "").strip().replace("\\", "/")
        if not name or name in {".", ".."} or "/" in name:
            raise ValueError("Некорректное имя")
        name = Path(name).name
        target = self._resolve_tree_path(path)
        if not target.exists():
            raise FileNotFoundError("Не найден")
        dest = target.parent / name
        if dest.exists():
            raise FileExistsError("Уже существует")
        target.rename(dest)
        entry_type = "dir" if dest.is_dir() else "file"
        result = {"path": str(dest), "type": entry_type}
        if entry_type == "file":
            result["language"] = language_for(dest)
        return result

    def delete_entry(self, path: str) -> dict:
        target = self._resolve_tree_path(path)
        if not target.exists():
            raise FileNotFoundError("Не найден")
        if target.is_dir():
            if any(target.iterdir()):
                raise ValueError("Папка не пустая")
            target.rmdir()
        else:
            target.unlink()
        return {"ok": True}

    def diagnose(self, path: str, content: str) -> list[dict]:
        source = content if isinstance(content, str) else str(content or "")
        if len(source) > 200_000:
            return []
        target = Path(path)
        ext = target.suffix.lower()
        if ext in {".py", ".pyw"}:
            return diagnose_python(str(target), source)
        if ext == ".json":
            return diagnose_json(str(target), source)
        return []

    def run_file(self, path: str) -> dict:
        target = self._abs_path(path)
        if target.suffix.lower() not in {".py", ".pyw"}:
            raise ValueError("Сейчас можно запускать только Python-файлы")
        with self._lock:
            root = self.root
        cwd = root if root is not None else target.parent
        python = sys.executable
        if getattr(sys, "frozen", False):
            import shutil

            python = shutil.which("python") or shutil.which("py") or "python"
        return self._run([python, "-u", str(target)], cwd=cwd)

    def run_command(self, command: str) -> dict:
        command = command.strip()
        if not command:
            raise ValueError("Пустая команда")
        return self._run(command, cwd=self._require_root(), shell=True)

    def _run(self, args, cwd: Path, shell: bool = False) -> dict:
        try:
            proc = subprocess.run(
                args,
                cwd=str(cwd),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=45,
                shell=shell,
            )
        except subprocess.TimeoutExpired:
            return {
                "stdout": "",
                "stderr": "Процесс превысил 45 секунд и был остановлен.",
                "code": -1,
                "timedOut": True,
            }
        return {
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "code": proc.returncode,
            "timedOut": False,
        }

    def _require_root(self) -> Path:
        with self._lock:
            root = self.root
        if root is None:
            raise RuntimeError("Сначала откройте папку")
        return root

    def _abs_path(self, path: str | Path) -> Path:
        return Path(path).expanduser().resolve()

    def _safe_path(self, path: str | Path) -> Path:
        root = self._require_root()
        target = Path(path).expanduser().resolve()
        if target != root and root not in target.parents:
            raise PermissionError("Путь вне открытой папки")
        return target


def language_for(path: Path) -> str:
    if path.name.lower() == "dockerfile":
        return "dockerfile"
    return LANGUAGE_BY_EXT.get(path.suffix.lower(), "plaintext")


def read_text_file(path: Path) -> str:
    raw = path.read_bytes()
    if b"\x00" in raw:
        raise UnicodeDecodeError("utf-8", raw, 0, 1, "бинарный файл")
    for encoding in ("utf-8-sig", "utf-8"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("cp1251")


def diagnose_python(path: str, source: str) -> list[dict]:
    problems: list[dict] = []
    try:
        compile(source, path, "exec")
    except SyntaxError as exc:
        problems.append(
            {
                "path": path,
                "line": max(1, exc.lineno or 1),
                "column": max(1, exc.offset or 1),
                "endLine": max(1, exc.end_lineno or exc.lineno or 1),
                "endColumn": max(1, (exc.end_offset or (exc.offset or 1) + 1)),
                "message": exc.msg or "Синтаксическая ошибка",
                "severity": "error",
                "source": "python",
            }
        )
    return problems


def diagnose_json(path: str, source: str) -> list[dict]:
    if not source.strip():
        return []
    try:
        json.loads(source)
        return []
    except json.JSONDecodeError as exc:
        return [
            {
                "path": path,
                "line": max(1, exc.lineno),
                "column": max(1, exc.colno),
                "endLine": max(1, exc.lineno),
                "endColumn": max(1, exc.colno + 1),
                "message": exc.msg,
                "severity": "error",
                "source": "json",
            }
        ]


workspace = Workspace()
