@echo off
setlocal enabledelayedexpansion

REM Run from the folder this script lives in, regardless of where it's launched from.
cd /d "%~dp0"

REM ---- Settings you can tweak ----
REM How often (seconds) to auto-check git for new commits while running.
set "POLL_SECONDS=60"
REM Title used for the dev-server window so we can restart it on demand.
set "SERVER_TITLE=Light-Lag Dev Server"

echo ============================================
echo  Light-Lag : update and launch
echo ============================================

REM --- First-run update + dependency install -------------------------------
set "LOCK_BEFORE="
if exist package-lock.json (
    for /f "delims=" %%H in ('git hash-object package-lock.json 2^>nul') do set "LOCK_BEFORE=%%H"
)

echo.
echo [1/3] Pulling latest from git...
git pull --ff-only
if errorlevel 1 (
    echo WARNING: git pull failed ^(offline or local conflict^). Continuing with what you have.
)

set "LOCK_AFTER="
if exist package-lock.json (
    for /f "delims=" %%H in ('git hash-object package-lock.json 2^>nul') do set "LOCK_AFTER=%%H"
)

echo.
echo [2/3] Checking dependencies...
set "NEED_INSTALL="
if not exist node_modules set "NEED_INSTALL=1"
if not "!LOCK_BEFORE!"=="!LOCK_AFTER!" set "NEED_INSTALL=1"

if defined NEED_INSTALL (
    echo Dependencies changed or missing - running npm install...
    call npm install
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed.
        pause
        exit /b 1
    )
) else (
    echo Dependencies are up to date - skipping npm install.
)

echo.
echo [3/3] Starting the dev server in its own window...
call :start_server

REM --- Live control loop: auto-poll for updates, or act on a keypress ------
REM Vite hot-reloads changed source files on its own, so a plain "git pull"
REM is enough for code changes. Only dependency changes need a reinstall and
REM a server restart, which this loop handles automatically.
:loop
echo.
echo ------------------------------------------------------------
echo   [U] update now    [R] restart server    [Q] quit
echo   Auto-checking for git updates every %POLL_SECONDS%s...
echo ------------------------------------------------------------
choice /c URQ /n /t %POLL_SECONDS% /d U >nul
REM choice errorlevel: 1=U (also the timeout default), 2=R, 3=Q
if errorlevel 3 goto quit
if errorlevel 2 (
    call :restart_server
    goto loop
)
call :check_and_apply
goto loop

REM ------------------------------------------------------------------------
:check_and_apply
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "HEAD_BEFORE=%%H"
set "LOCK_BEFORE="
if exist package-lock.json for /f "delims=" %%L in ('git hash-object package-lock.json 2^>nul') do set "LOCK_BEFORE=%%L"

git pull --ff-only >nul 2>&1
if errorlevel 1 (
    echo [%TIME%] git pull failed ^(offline or conflict^); will retry next cycle.
    goto :eof
)

for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "HEAD_AFTER=%%H"
if "%HEAD_BEFORE%"=="%HEAD_AFTER%" (
    echo [%TIME%] Already up to date.
    goto :eof
)

echo [%TIME%] Pulled new changes.
set "LOCK_AFTER="
if exist package-lock.json for /f "delims=" %%L in ('git hash-object package-lock.json 2^>nul') do set "LOCK_AFTER=%%L"

if not "%LOCK_BEFORE%"=="%LOCK_AFTER%" (
    echo Dependencies changed - reinstalling and restarting the server...
    call npm install
    call :restart_server
) else (
    echo Source updated - Vite hot-reload will apply it automatically.
)
goto :eof

REM ------------------------------------------------------------------------
:start_server
start "%SERVER_TITLE%" cmd /k npm run dev
goto :eof

REM ------------------------------------------------------------------------
:restart_server
echo Restarting the dev server...
taskkill /fi "WINDOWTITLE eq %SERVER_TITLE%*" /t /f >nul 2>&1
call :start_server
goto :eof

REM ------------------------------------------------------------------------
:quit
echo Stopping the dev server...
taskkill /fi "WINDOWTITLE eq %SERVER_TITLE%*" /t /f >nul 2>&1
endlocal
