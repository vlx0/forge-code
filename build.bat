@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PY=C:\Users\dedge\AppData\Local\Programs\Python\Python314\python.exe"
if not exist "%PY%" (
  echo Python 3.14 not found: %PY%
  exit /b 1
)

echo [1/4] Dependencies...
"%PY%" -m pip install -r "%~dp0requirements.txt" pillow pyinstaller --quiet
if errorlevel 1 (
  echo pip failed
  exit /b 1
)

echo [2/4] Cleaning old build...
if exist "%~dp0build\ForgeCode" rmdir /s /q "%~dp0build\ForgeCode"
if exist "%~dp0dist\ForgeCode" rmdir /s /q "%~dp0dist\ForgeCode"

echo [3/4] PyInstaller...
echo This can take several minutes and may load the PC heavily.
"%PY%" -m PyInstaller --noconfirm --clean --distpath "%~dp0dist" --workpath "%~dp0build\pyi" "%~dp0build\forgecode.spec"
if errorlevel 1 (
  echo Build failed
  exit /b 1
)

echo [4/4] Install to LocalAppData + shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build\install_app.ps1"
if errorlevel 1 (
  echo Install/shortcuts failed. EXE is still here:
  echo %~dp0dist\ForgeCode\ForgeCode.exe
  exit /b 1
)

echo.
echo OK
echo Portable: %~dp0dist\ForgeCode\ForgeCode.exe
echo Installed: %LOCALAPPDATA%\Programs\ForgeCode\ForgeCode.exe
echo Desktop shortcut: Forge Code
exit /b 0
