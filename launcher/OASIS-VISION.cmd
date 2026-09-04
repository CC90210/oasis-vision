@echo off
setlocal
rem OSIRIS - launch the dashboard as a desktop app window
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0osiris-launch.ps1" %*
