@echo off
title VasulBook (local)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Download the LTS version from https://nodejs.org , install it, then double-click this file again.
  pause
  exit /b
)
if not exist node_modules (
  echo Installing VasulBook. This happens only the first time...
  call npm install --no-audit --no-fund
)
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
echo Starting VasulBook. Keep this window open. Close it to stop the app.
call npm run local
pause
