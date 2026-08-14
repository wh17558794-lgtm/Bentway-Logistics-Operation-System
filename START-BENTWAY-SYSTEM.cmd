@echo off
cd /d "%~dp0"
set "BUNDLED_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED_PYTHON%" (
  "%BUNDLED_PYTHON%" "%~dp0preview_server.py" --port 8080 --open-browser
  goto :server_stopped
)
where py >nul 2>nul
if not errorlevel 1 (
  py "%~dp0preview_server.py" --port 8080 --open-browser
  goto :server_stopped
)
where python >nul 2>nul
if not errorlevel 1 (
  python "%~dp0preview_server.py" --port 8080 --open-browser
  goto :server_stopped
)
echo Python was not found, so the Bentway system could not start.
pause
exit /b

:server_stopped
echo.
echo The Bentway local system has stopped.
echo Keep this window open while using http://localhost:8080/
pause
