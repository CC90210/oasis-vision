@echo off
setlocal
rem Stop the OSIRIS background server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0osiris-stop.ps1"
