@echo off
if "%~1"=="--child" goto :child
chcp 65001 >nul 2>&1
title BlobTELEvision (DEV)
cd /d "%~dp0tauri"

echo.
echo  BlobTELEvision - MODE DEV (recompile a chaque lancement, ~1-2 min).
echo  Pour juste lancer l'app rapidement, utilise BlobTELEvision.bat a la place.
echo.

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

where cargo >nul 2>&1
if errorlevel 1 (
    echo Rust/Cargo introuvable. Installe-le via https://rustup.rs puis relance.
    pause
    exit /b 1
)

if not exist node_modules (
    echo  Installation des dependances frontend, premiere fois seulement...
    call npm install
    if errorlevel 1 (
        echo.
        echo Echec de "npm install" - voir l'erreur ci-dessus.
        pause
        exit /b 1
    )
)

REM The real run happens in a hidden console (output -> logs\dev.log) so no black
REM window stays on the desktop while the app is open. This console stays visible,
REM streaming the build, until the app window (splash screen) appears.
echo  Lancement...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\dev_launch.ps1" -Self "%~f0" -Log "%~dp0logs\dev.log"
if errorlevel 1 pause
exit /b 0

:child
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0tauri"
if not exist "..\logs" mkdir "..\logs"
call npm run tauri dev > "..\logs\dev.log" 2>&1
if errorlevel 1 start "" notepad "..\logs\dev.log"
exit /b 0
