@echo off
setlocal
rem Stop the OASIS VISION background server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0oasis-vision-stop.ps1"
