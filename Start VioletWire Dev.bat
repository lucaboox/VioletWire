@echo off
setlocal
title VioletWire Development
cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js and npm were not found in PATH.
  echo Install Node.js, then run this launcher again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo VioletWire dependencies are not installed.
  echo Run npm install in this folder, then try again.
  pause
  exit /b 1
)

call npm.cmd run dev
if errorlevel 1 (
  echo.
  echo VioletWire exited with an error.
  pause
)

endlocal
