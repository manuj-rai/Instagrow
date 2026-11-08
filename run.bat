@echo off
setlocal enableextensions enabledelayedexpansion
title Instagrow

REM ============================================================
REM  Launches Chrome (debug port) + Backend, then opens the UI.
REM  UI is served by the backend itself at /, so no separate
REM  frontend dev server is needed.
REM  Resolves all paths off %~dp0.
REM ============================================================

REM ---- Config (override via environment if you want) ----
if not defined BOT_DIR        set "BOT_DIR=%USERPROFILE%\ChromeBot"
if not defined CHROME_PROFILE set "CHROME_PROFILE=Profile 2"
if not defined DEBUG_PORT     set "DEBUG_PORT=9222"
if not defined BACKEND_PORT   set "BACKEND_PORT=4545"

set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%"

REM ---- Locate Chrome ----
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
    echo [ERROR] Chrome not found. Edit run.bat and set CHROME to the right path.
    pause
    exit /b 1
)

echo ============================================================
echo  Root         : %ROOT%
echo  Bot profile  : %BOT_DIR%\%CHROME_PROFILE%
echo  Debug port   : %DEBUG_PORT%
echo  Backend port : %BACKEND_PORT%  (UI served at /)
echo ============================================================

REM ---- Fast path: if backend is already up, just open the UI and exit ----
curl -s --connect-timeout 2 --max-time 3 "http://localhost:%BACKEND_PORT%/health" >nul 2>&1
if not errorlevel 1 (
    echo [info] Backend already running on port %BACKEND_PORT% - opening UI.
    start "" "%CHROME%" "http://localhost:%BACKEND_PORT%"
    exit /b 0
)

REM ---- First-time setup: copy Instagram session from real Chrome profile ----
if not exist "%BOT_DIR%\%CHROME_PROFILE%" (
    echo [setup] First run - copying Chrome '%CHROME_PROFILE%' to bot dir...
    set "SRC=%LOCALAPPDATA%\Google\Chrome\User Data\%CHROME_PROFILE%"
    if not exist "!SRC!" (
        echo [ERROR] Source profile not found: !SRC!
        echo         Open Chrome and verify the profile name, then re-run.
        pause
        exit /b 1
    )
    xcopy "!SRC!" "%BOT_DIR%\%CHROME_PROFILE%" /E /I /Q >nul
    echo [setup] Profile copied.
)

REM ---- Launch Chrome on debug port (skip if already up) ----
curl -s "http://localhost:%DEBUG_PORT%/json/version" >nul 2>&1
if not errorlevel 1 (
    echo [chrome] Already running on port %DEBUG_PORT% - reusing.
) else (
    echo [chrome] Launching with remote debugging on %DEBUG_PORT%...
    start "" "%CHROME%" ^
        --remote-debugging-port=%DEBUG_PORT% ^
        --user-data-dir="%BOT_DIR%" ^
        --profile-directory="%CHROME_PROFILE%" ^
        --no-first-run ^
        --no-default-browser-check ^
        --disable-background-timer-throttling ^
        --disable-backgrounding-occluded-windows ^
        --disable-renderer-backgrounding
    call :wait_http "http://localhost:%DEBUG_PORT%/json/version" 30 "chrome"
    if errorlevel 1 exit /b 1
)

REM ---- Backend (also serves the UI at / via express.static) ----
REM  /k keeps the spawned window open if npm crashes so the error stays
REM  visible. Window can be closed manually to stop the service.
echo [backend] Starting on port %BACKEND_PORT%...
start "ig-backend" /d "%BACKEND_DIR%" /min cmd /k "npm start"
call :wait_http "http://localhost:%BACKEND_PORT%/health" 60 "backend"
if errorlevel 1 exit /b 1

REM ---- Open the UI in your default Chrome (regular profile) ----
echo [open] Opening http://localhost:%BACKEND_PORT% in default Chrome...
start "" "%CHROME%" "http://localhost:%BACKEND_PORT%"

echo.
echo ============================================================
echo  All services up. Close the spawned windows to stop.
echo ============================================================
exit /b 0


REM ============================================================
REM  :wait_http <url> <timeout-seconds> <label>
REM  Polls the URL every 1s until it returns success or timeout.
REM ============================================================
:wait_http
setlocal
set "URL=%~1"
set "TIMEOUT=%~2"
set "LABEL=%~3"
set /a ELAPSED=0
:wait_http_loop
curl -s --connect-timeout 2 --max-time 5 -o nul "%URL%" >nul 2>&1
if not errorlevel 1 (
    echo [%LABEL%] Ready ^(%URL%^)
    endlocal & exit /b 0
)
if %ELAPSED% GEQ %TIMEOUT% (
    echo [%LABEL%] [ERROR] Timed out after %TIMEOUT%s waiting for %URL%
    endlocal & exit /b 1
)
timeout /t 1 /nobreak >nul
set /a ELAPSED+=1
goto wait_http_loop
