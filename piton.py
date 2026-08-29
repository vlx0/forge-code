from pitonkit import ask, ask_result

__all__ = ["ask", "ask_result", "build_analyze_messages", "build_explain_messages"]


def build_analyze_messages(code: str, *, filename: str = "", language: str = "") -> list[dict]:
    label = (filename or "фрагмент").strip()
    lang_line = f"Язык: {language}\n" if language else ""
    fence = language or "text"
    prompt = (
        f"Проанализируй этот код из «{label}».\n\n"
        f"{lang_line}"
        "Если код не идеален — перечисли проблемы и предложи конкретные улучшения "
        "(ошибки, стиль, читаемость, производительность, безопасность). "
        "Если код хорош — кратко похвали и укажи 1–2 сильные стороны.\n\n"
        "Ответ на русском, структурированно списком. "
        "Примеры исправлений — короткими фрагментами, не переписывай весь файл.\n\n"
        f"```{fence}\n{code.rstrip()}\n```"
    )
    return [{"role": "user", "content": prompt}]


def build_explain_messages(text: str, *, filename: str = "") -> list[dict]:
    label = (filename or "").strip()
    where = f" (файл: {label})" if label else ""
    prompt = (
        f"Объясни ошибку из вывода терминала{where}.\n\n"
        "Что сломалось, почему, и как исправить — кратко, по шагам, на русском. "
        "Если это traceback Python — укажи файл/строку и вероятную причину.\n\n"
        f"```\n{str(text or '').strip()}\n```"
    )
    return [{"role": "user", "content": prompt}]
