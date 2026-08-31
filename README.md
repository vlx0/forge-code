# Forge Code

Редактор Python для Windows. Пишешь код, запускаешь F5, смотришь вывод в терминале.

## Установка (без Python и без сборки)

Готовый zip: [Releases](https://github.com/vlx0/forge-code/releases/latest).

Из консоли (PowerShell):

```powershell
$zip = "$env:TEMP\ForgeCode.zip"
$dest = "$env:LOCALAPPDATA\Programs"
Invoke-WebRequest -Uri "https://github.com/vlx0/forge-code/releases/download/v1.0.0/ForgeCode-1.0.0-windows.zip" -OutFile $zip
Expand-Archive $zip $dest -Force
Start-Process "$dest\ForgeCode\ForgeCode.exe"
```

Распакуй zip и запусти `ForgeCode.exe`. Рядом должна остаться папка `_internal`.

## Запуск из исходников

Нужен Python 3.14.

```bat
pip install -r requirements.txt
pythonw app.py
```

Или `FC.bat` (путь к Python в bat привязан к машине, где писали скрипт).

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

Две версии. Переключатель в окне чата (`Ctrl+Shift+P`):

- **Voule 1.1** — производительнее: глубже думает, подробнее правит код.
- **Rodli 1.3 Flash** — на скорость: короче отвечает, без длинных мыслей.
