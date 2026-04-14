@echo off
setlocal

set SCRIPT_DIR=%~dp0
set DIST=%SCRIPT_DIR%dist
set OUT_EXE=%DIST%\takeover_launcher.exe
cd /d "%SCRIPT_DIR%"

echo [1/3] Installing dependencies...
call npm install --silent
if errorlevel 1 ( echo [!] npm install failed & goto :error )

echo [2/3] Building launcher executable...
call npm run build
if errorlevel 1 ( echo [!] Build failed & goto :error )

echo [3/3] Verifying output...
if not exist "%OUT_EXE%" (
  echo [!] Executable not found: %OUT_EXE%
  goto :error
)
for %%A in ("%OUT_EXE%") do set SIZE=%%~zA
set /a SIZE_MB=%SIZE% / 1048576
echo     [OK] %OUT_EXE%
echo     [OK] Size: %SIZE_MB% MB
echo.
echo [OK] Build complete.
exit /b 0

:error
echo [ERROR] Build failed.
exit /b 1
