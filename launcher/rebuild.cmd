@echo off
setlocal
rem Rebuild OASIS VISION after a git pull, a source edit, or a dependency change.
rem The server must be stopped first: it runs OUT OF .next\standalone, and Windows
rem will not let the build delete a directory that a live process is executing from
rem (EBUSY: resource busy or locked, rmdir .next\standalone).
cd /d "%~dp0.."
echo [1/4] Stopping any running OASIS VISION server...
call powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0osiris-stop.ps1"
echo [2/4] Installing dependencies...
call npm install || goto :fail
echo [3/4] Building...
call npm run build || goto :fail
echo [4/4] Syncing standalone assets...
call node launcher\sync-standalone.js || goto :fail
echo.
echo OASIS VISION rebuilt successfully. Launch it from the desktop icon.
pause
exit /b 0
:fail
echo.
echo BUILD FAILED - see the error above.
pause
exit /b 1
