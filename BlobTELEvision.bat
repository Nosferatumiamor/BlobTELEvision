@echo off
cd /d "%~dp0"

set "EXE=tauri\src-tauri\target\release\blobtelevision.exe"

if not exist "%EXE%" (
    echo.
    echo  BlobTELEvision n'a pas encore ete compile en mode release.
    echo  Lance ceci une fois pour le construire ^(quelques minutes^) :
    echo.
    echo      cd tauri
    echo      npm run tauri build
    echo.
    echo  Ou utilise BlobTELEvision-Dev.bat en attendant ^(plus lent a chaque lancement^).
    echo.
    pause
    exit /b 1
)

REM The app is a GUI program with no console of its own: start it and leave
REM straight away so this window disappears at once (no console stays open
REM behind the app). Startup problems are written to logs\startup-error.log
REM and logs\blobtelevision-api.log.
start "" "%EXE%"
exit /b 0
