@echo off
cd /d "%~dp0"
set "BUNDLED_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED_PYTHON%" (
  start "Suburb Expansion Server" /min "%BUNDLED_PYTHON%" "%~dp0preview_server.py" --port 18080
  timeout /t 2 /nobreak >nul
  start "" "http://localhost:18080/expand-suburbs-to-500.html"
  exit /b
)
where py >nul 2>nul
if not errorlevel 1 (
  start "Suburb Expansion Server" /min py "%~dp0preview_server.py" --port 18080
  timeout /t 2 /nobreak >nul
  start "" "http://localhost:18080/expand-suburbs-to-500.html"
  exit /b
)
where python >nul 2>nul
if not errorlevel 1 (
  start "Suburb Expansion Server" /min python "%~dp0preview_server.py" --port 18080
  timeout /t 2 /nobreak >nul
  start "" "http://localhost:18080/expand-suburbs-to-500.html"
  exit /b
)
echo Python was not found, so the suburb expansion tool could not start.
pause
