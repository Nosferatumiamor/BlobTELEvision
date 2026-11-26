@echo off
chcp 65001 >nul 2>&1
title BlobTELEvision
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

echo.
echo  BlobTELEvision - demarrage...
echo.

start "" "%EXE%"

REM Give it a moment, then check it's actually still running: if it is,
REM this window has done its job and closes itself instead of sitting
REM there for the whole session showing nothing new (the real app window
REM is already up by now). If it crashed within that window, stay open
REM and say so instead of vanishing silently.
timeout /t 3 /nobreak >nul
tasklist /fi "imagename eq blobtelevision.exe" 2>nul | find /i "blobtelevision.exe" >nul
if errorlevel 1 (
    echo.
    echo  BlobTELEvision n'a pas demarre correctement.
    echo  Details : logs\blobtelevision-api.log
    echo.
    pause
)
