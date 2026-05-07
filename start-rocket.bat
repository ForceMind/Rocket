@echo off
setlocal

cd /d "%~dp0"

if "%PORT%"=="" set "PORT=3000"

where node >nul 2>nul
if %errorlevel%==0 (
  set "NODE_EXE=node"
) else (
  set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)

if not exist "%NODE_EXE%" if not "%NODE_EXE%"=="node" (
  echo Node.js was not found.
  echo Install Node.js or run this from Codex with the bundled runtime available.
  pause
  exit /b 1
)

echo Starting Rocket Crash Platform...
echo Player: http://localhost:%PORT%/
echo Admin : http://localhost:%PORT%/admin
echo Admin auth: disabled
echo.

start "" "http://localhost:%PORT%/"
"%NODE_EXE%" server.js

pause
