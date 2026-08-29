from __future__ import annotations

import re
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field

from piton import ask_result

_lock = threading.Lock()
_jobs: dict[str, "PitonJob"] = {}
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="piton")
_JOB_HARD_TIMEOUT = 75.0


@dataclass
class PitonJob:
    job_id: str
    cancel: threading.Event = field(default_factory=threading.Event)
    done: bool = False
    error: str | None = None
    reply: str = ""
    provider: str | None = None
    model: str | None = None
    tried: int | None = None
    future: Future | None = None
    started_at: float = field(default_factory=time.monotonic)


def _reset_executor() -> None:
    global _executor
    _executor.shutdown(wait=False, cancel_futures=True)
    _executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="piton")


def _typewriter_pieces(text: str) -> list[str]:
    parts = re.findall(r"\S+\s*|\s+", text)
    if not parts:
        return [text] if text else []
    chunks: list[str] = []
    buf = ""
    for part in parts:
        buf += part
        if len(buf) >= 10 or part.endswith(("\n", ". ", "! ", "? ", ".\n")):
            chunks.append(buf)
            buf = ""
    if buf:
        chunks.append(buf)
    return chunks


def _run_job(job: PitonJob, messages: list[dict], skip_cache: bool) -> None:
    def on_delta(_piece: str) -> None:
        # ответ целиком; печать — ниже typewriter'ом
        if job.cancel.is_set():
            raise RuntimeError("Отменено")

    try:
        result = ask_result(
            messages if isinstance(messages, list) else [],
            skip_cache=bool(skip_cache),
            on_delta=on_delta,
            max_total_seconds=55,
        )
    except Exception as exc:
        with _lock:
            job.error = str(exc) or exc.__class__.__name__
            job.done = True
        return

    if job.cancel.is_set():
        with _lock:
            job.error = "Отменено"
            job.done = True
        return

    with _lock:
        job.provider = result.get("provider")
        job.model = result.get("model")
        job.tried = result.get("tried")

    if not result.get("ok"):
        with _lock:
            job.error = result.get("error") or "Нет ответа. Нажми «Ещё раз»."
            job.done = True
        return

    full = str(result.get("reply") or "").strip()
    if not full:
        with _lock:
            job.error = "Пустой ответ провайдера. Нажми «Ещё раз»."
            job.done = True
        return

    if len(full) > 20:
        with _lock:
            job.reply = ""
        for piece in _typewriter_pieces(full):
            if job.cancel.is_set():
                with _lock:
                    job.error = "Отменено"
                    job.done = True
                return
            with _lock:
                job.reply += piece
            time.sleep(0.012)
    else:
        with _lock:
            job.reply = full

    with _lock:
        job.done = True


def start(messages: list[dict], skip_cache: bool = False) -> str:
    job_id = uuid.uuid4().hex
    job = PitonJob(job_id=job_id)
    future = _executor.submit(_run_job, job, messages, bool(skip_cache))
    job.future = future
    with _lock:
        # не копить вечные хвосты
        stale = [jid for jid, item in _jobs.items() if item.done]
        for jid in stale:
            _jobs.pop(jid, None)
        _jobs[job_id] = job
    return job_id


def poll(job_id: str) -> dict:
    with _lock:
        job = _jobs.get(str(job_id or ""))
        if job is None:
            return {"done": True, "error": "Задача не найдена"}
        if (not job.done) and (time.monotonic() - job.started_at > _JOB_HARD_TIMEOUT):
            job.cancel.set()
            job.error = "Слишком долго. Нажми «Ещё раз»."
            job.done = True
        snapshot = {
            "done": job.done,
            "reply": job.reply,
            "provider": job.provider,
            "model": job.model,
            "tried": job.tried,
            "error": job.error,
        }
        finished = job.done
    if finished:
        with _lock:
            _jobs.pop(str(job_id or ""), None)
        if snapshot["error"]:
            return {
                "done": True,
                "error": snapshot["error"],
                "provider": snapshot["provider"],
                "model": snapshot["model"],
                "tried": snapshot["tried"],
                "reply": snapshot["reply"] or "",
            }
        if not str(snapshot["reply"] or "").strip():
            return {
                "done": True,
                "error": "Нет ответа. Нажми «Ещё раз».",
                "provider": snapshot["provider"],
                "model": snapshot["model"],
                "tried": snapshot["tried"],
            }
        return {
            "done": True,
            "reply": snapshot["reply"],
            "provider": snapshot["provider"],
            "model": snapshot["model"],
            "tried": snapshot["tried"],
        }
    return {
        "done": False,
        "reply": snapshot["reply"] or "",
        "provider": snapshot["provider"],
        "model": snapshot["model"],
    }


def cancel(job_id: str) -> dict:
    with _lock:
        job = _jobs.pop(str(job_id or ""), None)
    if job is not None:
        job.cancel.set()
        if job.future is not None and not job.future.done():
            job.future.cancel()
    _reset_executor()
    return {"ok": True}
