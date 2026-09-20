@echo off
setlocal
rem OASIS VISION - launch the dashboard as a desktop app window
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0oasis-vision-launch.ps1" %*
