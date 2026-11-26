@echo off
cd /d "%~dp0"
echo.
echo  BlobTELEvision - build de l'installeur (quelques minutes).
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-Installer.ps1"
if errorlevel 1 (
    echo.
    echo  Echec du build - voir l'erreur ci-dessus.
) else (
    echo.
    echo  Termine.
)
pause
