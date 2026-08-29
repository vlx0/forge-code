from __future__ import annotations

import time

# 8 моделей — порядок по силе написания кода.
MODEL_TIERS: tuple[dict, ...] = (
    {
        "model": "claude-sonnet-4-20250514",
        "aliases": ("claude-sonnet-4",),
        "providers": (
            "Anthropic",
            "GithubCopilot",
            "BlackboxPro",
            "Puter",
            "OpenaiChat",
        ),
    },
    {
        "model": "gpt-5.1",
        "providers": (
            "Puter",
            "OpenaiChat",
            "OpenaiAccount",
            "GithubCopilot",
            "BlackboxPro",
        ),
    },
    {
        "model": "gpt-4.1",
        "providers": (
            "GithubCopilot",
            "OpenaiChat",
            "BlackboxPro",
            "OpenaiAccount",
            "Pollinations",
            "Puter",
        ),
    },
    {
        "model": "deepseek-v3",
        "providers": (
            "PhindAi",
            "Puter",
            "Together",
            "BlackboxPro",
            "DeepInfra",
            "DeepSeek",
        ),
    },
    {
        "model": "gpt-4o",
        "providers": (
            "OpenaiChat",
            "BlackboxPro",
            "Copilot",
            "CopilotAccount",
            "CopilotApp",
            "OpenaiAccount",
            "GithubCopilot",
            "Pollinations",
        ),
    },
    {
        "model": "gpt-4",
        "providers": (
            "Copilot",
            "CopilotAccount",
            "CopilotApp",
            "OpenaiChat",
            "GithubCopilot",
            "BlackboxPro",
            "OpenaiAccount",
            "Yqcloud",
            "Pollinations",
        ),
    },
    {
        "model": "qwen-plus",
        "aliases": ("qwen3.7-plus",),
        "providers": (
            "Qwen",
            "Puter",
            "BlackboxPro",
        ),
    },
    {
        "model": "llama-3.3-70b-versatile",
        "aliases": ("llama-3.3-70b",),
        "providers": (
            "Groq",
            "Together",
            "Cloudflare",
            "Cerebras",
            "Puter",
            "BlackboxPro",
        ),
    },
)

SKIP_PROVIDER_NAMES = {
    "ProviderType",
    "ProviderUtils",
    "BaseProvider",
    "AsyncProvider",
    "AsyncGeneratorProvider",
    "RetryProvider",
    "IterListProvider",
    "RotatedProvider",
    "CreateImagesProvider",
    "Custom",
    "Local",
    "OpenaiTemplate",
    "PollinationsImage",
}

# Последний успешный маршрут — первым на следующем запросе.
_route_cache: dict[str, str] | None = None
_discovery_cache: dict[tuple[str, tuple[str, ...]], tuple[str, ...]] = {}

# Быстрый старт: провайдеры, которые часто работают без ключа.
BOOTSTRAP_ROUTES: tuple[tuple[str, str], ...] = (
    ("Yqcloud", "gpt-4"),
    ("Cloudflare", "llama-3.3-70b"),
    ("Pollinations", "gpt-4o-mini"),
    ("TeachAnything", "gpt-4"),
)


def _flatten_mapping(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, dict):
        items: list[str] = []
        for key, item in value.items():
            items.append(str(key))
            if isinstance(item, str):
                items.append(item)
            elif isinstance(item, (list, tuple)):
                items.extend(str(part) for part in item)
        return items
    if isinstance(value, (list, tuple, set)):
        items = []
        for item in value:
            if isinstance(item, str):
                items.append(item)
            elif isinstance(item, (list, tuple)):
                items.extend(str(part) for part in item)
        return items
    return [str(value)]


def _provider_supports_model(provider_cls, model: str, aliases: tuple[str, ...]) -> bool:
    parts = set(_flatten_mapping(getattr(provider_cls, "default_model", None)))
    parts.update(_flatten_mapping(getattr(provider_cls, "models", None)))
    parts.update(_flatten_mapping(getattr(provider_cls, "model_aliases", None)))
    parts.update(_flatten_mapping(getattr(provider_cls, "model_map", None)))
    parts.update(_flatten_mapping(getattr(provider_cls, "models_map", None)))
    haystack = " | ".join(parts)
    names = (model, *aliases)
    return any(name in parts or name in haystack for name in names)


def _resolve_provider(name: str):
    if name == "AnyProvider":
        try:
            from g4f.providers.any_provider import AnyProvider

            return AnyProvider
        except ImportError:
            return None
    from g4f import Provider

    cls = getattr(Provider, name, None)
    if cls is None:
        return None
    if getattr(cls, "working", True) is False:
        return None
    return cls


def _discover_provider_names(model: str, aliases: tuple[str, ...]) -> tuple[str, ...]:
    key = (model, aliases)
    cached = _discovery_cache.get(key)
    if cached is not None:
        return cached

    from g4f import Provider

    names: list[str] = []
    for name in dir(Provider):
        if name.startswith("_") or name in SKIP_PROVIDER_NAMES:
            continue
        cls = getattr(Provider, name, None)
        if cls is None or getattr(cls, "working", True) is False:
            continue
        if _provider_supports_model(cls, model, aliases):
            names.append(name)

    cached = tuple(names)
    _discovery_cache[key] = cached
    return cached


def _resolve_provider_names(names: tuple[str, ...]) -> list[object]:
    chain: list[object] = []
    seen: set[str] = set()
    for name in names:
        if name in seen:
            continue
        provider = _resolve_provider(name)
        if provider is None:
            continue
        seen.add(name)
        chain.append(provider)
    return chain


def _provider_chain(model: str, preferred: tuple[str, ...], aliases: tuple[str, ...], *, extended: bool) -> list[object]:
    names: list[str] = list(preferred)
    if extended:
        seen = set(names)
        for name in _discover_provider_names(model, aliases):
            if name not in seen:
                seen.add(name)
                names.append(name)
        if "AnyProvider" not in seen:
            names.append("AnyProvider")
    return _resolve_provider_names(tuple(names))


def _normalize(messages: list[dict]) -> list[dict]:
    payload = [
        {"role": str(item.get("role") or "user"), "content": str(item.get("content") or "")}
        for item in messages
    ]
    return [item for item in payload if item["content"].strip()]


def _try_request(
    g4f,
    provider,
    model: str,
    payload: list[dict],
    timeout: int,
    on_delta=None,
) -> str | None:
    # Без stream=True: у части провайдеров стрим зависает или отдаёт всё одним куском.
    # Печать по частям делаем сами через on_delta / typewriter в piton_jobs.
    reply = g4f.ChatCompletion.create(
        model=model,
        messages=payload,
        provider=provider,
        stream=False,
        timeout=timeout,
    )
    text = str(reply or "").strip()
    if text and on_delta:
        on_delta(text)
    return text or None


def _remember_route(provider, model: str) -> None:
    global _route_cache
    _route_cache = {
        "provider": getattr(provider, "__name__", str(provider)),
        "model": model,
    }
    _save_route_cache(_route_cache)


def _route_cache_path():
    from pathlib import Path

    return Path.home() / ".forgecode" / "piton_route.json"


def _load_route_cache() -> dict[str, str] | None:
    path = _route_cache_path()
    if not path.is_file():
        return None
    try:
        import json

        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    provider = str(data.get("provider") or "").strip()
    model = str(data.get("model") or "").strip()
    if not provider or not model:
        return None
    return {"provider": provider, "model": model}


def _save_route_cache(route: dict[str, str]) -> None:
    path = _route_cache_path()
    try:
        import json

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(route, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def _short_error(exc: BaseException) -> str:
    name = type(exc).__name__
    text = str(exc or "").strip().replace("\n", " ")
    if not text:
        return name
    if len(text) > 120:
        text = text[:117] + "…"
    return f"{name}: {text}"


def _attempt_route(
    g4f,
    provider,
    model: str,
    payload: list[dict],
    timeout: int,
    errors: list[str],
    on_delta=None,
) -> str | None:
    pname = getattr(provider, "__name__", str(provider))
    try:
        text = _try_request(g4f, provider, model, payload, timeout, on_delta=on_delta)
    except Exception as exc:
        errors.append(f"{pname}/{model}: {_short_error(exc)}")
        return None
    if text:
        _remember_route(provider, model)
        return text
    errors.append(f"{pname}/{model}: пустой ответ")
    return None


def _attempt_variants(
    g4f,
    provider,
    model: str,
    aliases: tuple[str, ...],
    payload: list[dict],
    timeout: int,
    *,
    aliases_only: bool,
    errors: list[str],
    on_delta=None,
) -> tuple[str | None, str | None]:
    if not aliases_only:
        text = _attempt_route(g4f, provider, model, payload, timeout, errors, on_delta=on_delta)
        if text:
            return text, model
    for alias in aliases:
        text = _attempt_route(g4f, provider, alias, payload, timeout, errors, on_delta=on_delta)
        if text:
            return text, alias
    return None, None


def _walk_tiers(
    g4f,
    tiers,
    payload: list[dict],
    timeout: int,
    *,
    extended: bool,
    deadline: float,
    errors: list[str],
    on_delta=None,
) -> tuple[str | None, str | None, str | None]:
    for tier in tiers:
        if time.monotonic() >= deadline:
            break
        model = str(tier["model"])
        aliases = tuple(str(item) for item in tier.get("aliases", ()))
        preferred = tuple(str(item) for item in tier.get("providers", ()))
        providers = _provider_chain(model, preferred, aliases, extended=extended)
        for provider in providers:
            if time.monotonic() >= deadline:
                break
            wait = max(1, min(timeout, int(deadline - time.monotonic())))
            text, used_model = _attempt_variants(
                g4f,
                provider,
                model,
                aliases,
                payload,
                wait,
                aliases_only=False,
                errors=errors,
                on_delta=on_delta,
            )
            if text:
                return text, getattr(provider, "__name__", str(provider)), used_model or model
    return None, None, None


def _failure_message(errors: list[str], *, timed_out: bool) -> str:
    tried = len(errors)
    if timed_out:
        base = f"Время вышло. Провайдеры не успели ответить (попыток: {tried})."
    elif tried:
        base = f"Все провайдеры не ответили (попыток: {tried})."
    else:
        base = "Не удалось найти рабочий провайдер."
    hint = " Нажми «Ещё раз» или подожди минуту."
    sample = ""
    if errors:
        last = errors[-1]
        sample = f" Последняя ошибка: {last}"
    return base + hint + sample


def ask_result(
    messages: list[dict],
    *,
    models: list[str] | None = None,
    timeout: int = 8,
    fast_timeout: int = 4,
    max_total_seconds: int = 60,
    skip_cache: bool = False,
    on_delta=None,
) -> dict:
    try:
        import g4f
    except ImportError as exc:
        return {
            "ok": False,
            "reply": "",
            "provider": None,
            "model": None,
            "error": "Не установлен g4f. Запусти FC.bat ещё раз.",
            "tried": 0,
            "streamed": False,
        }

    payload = _normalize(messages)
    if not payload:
        return {
            "ok": False,
            "reply": "",
            "provider": None,
            "model": None,
            "error": "Пустой запрос.",
            "tried": 0,
            "streamed": False,
        }

    deadline = time.monotonic() + max_total_seconds
    errors: list[str] = []
    delta_count = {"n": 0}

    def _delta(piece: str) -> None:
        if not piece:
            return
        delta_count["n"] += 1
        if on_delta:
            on_delta(piece)

    global _route_cache
    if skip_cache:
        _route_cache = None
    elif _route_cache is None:
        _route_cache = _load_route_cache()

    def _ok(text: str, provider_name: str, model_name: str) -> dict:
        return {
            "ok": True,
            "reply": text,
            "provider": provider_name,
            "model": model_name,
            "error": None,
            "tried": len(errors),
            "streamed": delta_count["n"] > 1,
        }

    if _route_cache and time.monotonic() < deadline:
        provider = _resolve_provider(_route_cache["provider"])
        cached_model = str(_route_cache["model"])
        if provider is not None:
            wait = max(1, min(timeout, int(deadline - time.monotonic())))
            text = _attempt_route(
                g4f, provider, cached_model, payload, wait, errors, on_delta=_delta
            )
            if text:
                return _ok(text, getattr(provider, "__name__", str(provider)), cached_model)
        _route_cache = None

    for provider_name, model_name in BOOTSTRAP_ROUTES:
        if time.monotonic() >= deadline:
            break
        provider = _resolve_provider(provider_name)
        if provider is None:
            continue
        wait = max(1, min(timeout, int(deadline - time.monotonic())))
        text = _attempt_route(
            g4f, provider, model_name, payload, wait, errors, on_delta=_delta
        )
        if text:
            return _ok(text, provider_name, model_name)

    tiers = list(MODEL_TIERS)
    if models:
        tiers.insert(
            0,
            {
                "model": str(models[0]),
                "aliases": tuple(str(item) for item in models[1:]),
                "providers": ("OpenaiChat", "BlackboxPro", "Pollinations", "AnyProvider"),
            },
        )

    text = provider_name = used_model = None
    if time.monotonic() < deadline:
        text, provider_name, used_model = _walk_tiers(
            g4f,
            tiers,
            payload,
            fast_timeout,
            extended=False,
            deadline=deadline,
            errors=errors,
            on_delta=_delta,
        )
    if not text and time.monotonic() < deadline:
        text, provider_name, used_model = _walk_tiers(
            g4f,
            tiers,
            payload,
            timeout,
            extended=True,
            deadline=deadline,
            errors=errors,
            on_delta=_delta,
        )

    if text:
        return _ok(text, provider_name or "?", used_model or "?")

    timed_out = time.monotonic() >= deadline
    return {
        "ok": False,
        "reply": "",
        "provider": None,
        "model": None,
        "error": _failure_message(errors, timed_out=timed_out),
        "tried": len(errors),
        "streamed": False,
    }


def ask(
    messages: list[dict],
    *,
    models: list[str] | None = None,
    timeout: int = 8,
    fast_timeout: int = 4,
    max_total_seconds: int = 60,
    skip_cache: bool = False,
) -> str:
    result = ask_result(
        messages,
        models=models,
        timeout=timeout,
        fast_timeout=fast_timeout,
        max_total_seconds=max_total_seconds,
        skip_cache=skip_cache,
    )
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or "Нет ответа от Piton")
    return str(result.get("reply") or "")


def chat(messages: list[dict], **kwargs) -> str:
    return ask(messages, **kwargs)


def model_hierarchy() -> list[dict]:
    rows = []
    for tier in MODEL_TIERS:
        model = str(tier["model"])
        aliases = tuple(str(item) for item in tier.get("aliases", ()))
        preferred = tuple(str(item) for item in tier.get("providers", ()))
        names = []
        for provider in _provider_chain(model, preferred, aliases, extended=True):
            names.append(getattr(provider, "__name__", str(provider)))
        rows.append({"model": model, "aliases": list(aliases), "providers": names})
    return rows
