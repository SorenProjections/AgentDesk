@echo off
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" launch.mjs --stop
) else (
  node.exe launch.mjs --stop
)
if errorlevel 1 pause
