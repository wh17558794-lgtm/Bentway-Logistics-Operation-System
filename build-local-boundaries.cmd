@echo off
cd /d "%~dp0"
set "BUNDLED_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED_PYTHON%" (
  start "Local Boundary Builder" /min "%BUNDLED_PYTHON%" "%~dp0preview_server.py" --port 18080
  timeout /t 2 /nobreak >nul
  start "" "http://localhost:18080/prepare-local-boundaries.html"
  exit /b
)
where py >nul 2>nul
if not errorlevel 1 (
  start "Local Boundary Builder" /min py "%~dp0preview_server.py" --port 18080
  timeout /t 2 /nobreak >nul
  start "" "http://localhost:18080/prepare-local-boundaries.html"
  exit /b
)
where python >nul 2>nul
if not errorlevel 1 (
  start "Local Boundary Builder" /min python "%~dp0preview_server.py" --port 18080
  timeout /t 2 /nobreak >nul
  start "" "http://localhost:18080/prepare-local-boundaries.html"
  exit /b
)
echo Python was not found, so the boundary builder could not start.
pause
