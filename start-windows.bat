@echo off
setlocal
cd /d "%~dp0"
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo FFmpeg is required. Install it and add its bin folder to PATH. See README.md.
  pause
  exit /b 1
)
where ffprobe >nul 2>nul
if errorlevel 1 (
  echo ffprobe is required. Install the complete FFmpeg package. See README.md.
  pause
  exit /b 1
)
if not exist .venv\Scripts\python.exe (
  py -3.12 -m venv .venv
  if errorlevel 1 (
    echo Python 3.12 is required. See README.md.
    pause
    exit /b 1
  )
)
.venv\Scripts\python.exe -m pip install -r requirements.lock
if errorlevel 1 (
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8000 in your browser after the server starts.
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
pause

