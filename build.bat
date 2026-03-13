@echo off
setlocal

:: ============================================================
::  TAKEOVER LAUNCHER BUILD SCRIPT
::  Change VERSION below, then double-click (or run in cmd).
:: ============================================================

set VERSION=2.0.6

:: ── Derive paths ────────────────────────────────────────────
set SCRIPT_DIR=%~dp0
set PKG=%SCRIPT_DIR%package.json
set CFG=%SCRIPT_DIR%config.json
set DIST=%SCRIPT_DIR%dist
set OUT_EXE=%DIST%\takeover.exe
set RELEASE_EXE=%DIST%\takeover.%VERSION%.exe

echo.
echo ============================================================
echo  Building Takeover Launcher  v%VERSION%
echo ============================================================
echo.

:: ── 1. Update package.json version ──────────────────────────
echo [1/5] Updating package.json version to %VERSION%...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$f='%PKG%'; $j=Get-Content $f -Raw | ConvertFrom-Json; $j.version='%VERSION%'; $j | ConvertTo-Json -Depth 10 | Set-Content $f -Encoding UTF8"
if errorlevel 1 ( echo ERROR: Failed to update package.json & goto :error )

:: ── 2. Update config.json version fields ─────────────────────
echo [2/5] Updating config.json version fields to %VERSION%...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$f='%CFG%'; $j=Get-Content $f -Raw | ConvertFrom-Json; $j.version='%VERSION%'; $j.launcher_version='%VERSION%'; $j.launcher_exe_url='https://github.com/0FFIT/takeover_launcher/releases/download/v%VERSION%/takeover.%VERSION%.exe'; $j | ConvertTo-Json -Depth 10 | Set-Content $f -Encoding UTF8"
if errorlevel 1 ( echo ERROR: Failed to update config.json & goto :error )

:: ── 3. npm install ───────────────────────────────────────────
echo [3/5] Installing dependencies (npm install)...
cd /d "%SCRIPT_DIR%"
call npm install
if errorlevel 1 ( echo ERROR: npm install failed & goto :error )

:: ── 4. npm run build ─────────────────────────────────────────
echo [4/5] Building with electron-builder...
call npm run build
if errorlevel 1 ( echo ERROR: Build failed & goto :error )

:: ── 5. Rename output exe ─────────────────────────────────────
echo [5/5] Renaming output to takeover.%VERSION%.exe...
if not exist "%OUT_EXE%" (
  echo ERROR: Expected output not found: %OUT_EXE%
  goto :error
)
if exist "%RELEASE_EXE%" del /f /q "%RELEASE_EXE%"
ren "%OUT_EXE%" "takeover.%VERSION%.exe"
if errorlevel 1 ( echo ERROR: Rename failed & goto :error )

echo.
echo ============================================================
echo  BUILD COMPLETE
echo  Output: %RELEASE_EXE%
echo ============================================================
echo.
goto :done

:error
echo.
echo BUILD FAILED — see error above.
echo.
exit /b 1

:done
endlocal
pause
