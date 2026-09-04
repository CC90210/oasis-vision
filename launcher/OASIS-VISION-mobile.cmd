@echo off
setlocal
rem OASIS VISION - phone / tablet mode.
rem Binds the server to the local network and prints the URL to open on your phone.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0osiris-launch.ps1" -Lan -NoWindow
echo.
pause
