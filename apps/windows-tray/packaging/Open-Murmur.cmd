@echo off
setlocal
rem Without arguments open the tray directly: no PowerShell window, no folder dialog.
if "%~1"=="" (
  start "" "%~dp0murmur-tray.exe"
  exit /b 0
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Open-Murmur.ps1" %*
if errorlevel 1 pause
