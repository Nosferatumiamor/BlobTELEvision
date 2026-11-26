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

REM The real run happens in a hidden console, so no black window stays on the
REM desktop while the app is open. Its output goes to logs\dev.log, which is
REM only opened if the build or the app fails.
echo  Lancement... la fenetre de l'app apparait dans 1 a 2 minutes (compilation).
echo  Log : logs\dev.log
set "SELF=%~f0"
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process cmd.exe -WindowStyle Hidden -ArgumentList '/c', ('\"' + $env:SELF + '\" --child')"
ping -n 5 127.0.0.1 >nul
exit /b 0

:child
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0tauri"
if not exist "..\logs" mkdir "..\logs"
call npm run tauri dev > "..\logs\dev.log" 2>&1
if errorlevel 1 start "" notepad "..\logs\dev.log"
exit /b 0
