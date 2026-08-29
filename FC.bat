@echo off
cd /d "%~dp0"
set "PY=C:\Users\dedge\AppData\Local\Programs\Python\Python314\python.exe"
set "PYW=C:\Users\dedge\AppData\Local\Programs\Python\Python314\pythonw.exe"
if not exist "%PY%" (
  echo Не найден Python 3.14:
  echo %PY%
  pause
  exit /b 1
)
"%PY%" -c "import webview, winpty, pitonkit" 2>nul
if errorlevel 1 (
  echo Установка зависимостей Forge Code...
  "%PY%" -m pip install -r "%~dp0requirements.txt"
  if errorlevel 1 (
    echo Не удалось установить пакеты. Проверь интернет и pip.
    pause
    exit /b 1
  )
)
start "" "%PYW%" "%~dp0app.py" %*
