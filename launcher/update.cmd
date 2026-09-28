@echo off
setlocal
rem Update OASIS VISION from GitHub, rebuild it, and reopen it.
rem The installed app runs the BUILT copy in .next\standalone, so a git pull
rem alone changes nothing you can see; this does the whole chain. It refuses
rem to run over uncommitted work, untracked files included: an untracked file
rem under src\ would be built into the app unreviewed. Ignored files
rem (.env.local, logs, build output) do not count.
cd /d "%~dp0.."
for /f "delims=" %%s in ('git status --porcelain') do goto :dirty
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
echo [1/6] Pulling %BRANCH% from origin...
git pull --ff-only origin %BRANCH% || goto :fail
echo [2/6] Stopping any running OASIS VISION server...
call powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0oasis-vision-stop.ps1"
echo [3/6] Installing dependencies...
call npm install || goto :fail
echo [4/6] Building...
call npm run build || goto :fail
echo [5/6] Syncing standalone assets...
call node launcher\sync-standalone.js || goto :fail
echo [6/6] Starting...
call powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0oasis-vision-launch.ps1"
exit /b 0
:dirty
echo Uncommitted work in %CD%. Commit, stash or remove it, then run this again:
git status --short
pause
exit /b 1
:fail
echo.
echo UPDATE FAILED - see the error above.
pause
exit /b 1
