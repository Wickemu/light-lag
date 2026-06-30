@echo off
setlocal enabledelayedexpansion

REM Run from the folder this script lives in, regardless of where it's launched from.
cd /d "%~dp0"

echo ============================================
echo  Light-Lag : update and launch
echo ============================================

REM --- Record the lockfile content hash before pulling ---
set "LOCK_BEFORE="
if exist package-lock.json (
    for /f "delims=" %%H in ('git hash-object package-lock.json 2^>nul') do set "LOCK_BEFORE=%%H"
)

echo.
echo [1/3] Pulling latest from git...
git pull
if errorlevel 1 (
    echo.
    echo ERROR: git pull failed. Resolve the issue above and try again.
    pause
    exit /b 1
)

REM --- Record the lockfile content hash after pulling ---
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
echo [3/3] Starting the dev server...
call npm run dev

endlocal
