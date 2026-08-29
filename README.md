# Forge Code

Редактор Python для Windows. Пишешь код, запускаешь F5, смотришь вывод в терминале.

## Запуск из исходников

Нужен Python 3.14.

```bat
FC.bat
```

Или:

```bat
pip install -r requirements.txt
pythonw app.py
```

## Сборка приложения

```bat
build.bat
```

После сборки появится `ForgeCode.exe` и ярлык **Forge Code** на рабочем столе.

## Горячие клавиши

| Клавиша | Действие |
| --- | --- |
| `F5` | Запуск текущего файла |
| `Shift+F5` | Стоп |
| `Ctrl+S` | Сохранить |
| `Ctrl+P` | Быстрое открытие файла |
| `Ctrl+\`` | Терминал |
| `Ctrl+Shift+P` | Piton |

## Piton

Встроенный чат по коду и ошибкам. Открывается по `Ctrl+Shift+P`.
