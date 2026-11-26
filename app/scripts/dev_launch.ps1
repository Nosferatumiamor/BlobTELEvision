# Used by BlobTELEvision-Dev.bat. Runs `tauri dev` in a hidden console (output -> logs\dev.log)
# and keeps THIS console visible, streaming that log, until the app window shows up (splash
# screen), then exits so no black window stays on the desktop while the app is open.
# Exit code 0 = the app window appeared, 1 = the build/app died before showing a window.
param(
    [Parameter(Mandatory = $true)][string]$Self,
    [Parameter(Mandatory = $true)][string]$Log,
    [string]$ProcessName = "blobtelevision"
)
$ErrorActionPreference = "Continue"
$started = Get-Date
if (Test-Path $Log) { Remove-Item $Log -Force -ErrorAction SilentlyContinue }

$child = Start-Process -FilePath cmd.exe -WindowStyle Hidden -PassThru `
    -ArgumentList '/c', ('"' + $Self + '" --child')

$seen = 0
$spin = 0
while ($true) {
    if (Test-Path $Log) {
        $lines = @(Get-Content -Path $Log -Encoding UTF8 -ErrorAction SilentlyContinue)
        if ($lines.Count -gt $seen) {
            $lines[$seen..($lines.Count - 1)] | ForEach-Object { Write-Host $_ }
            $seen = $lines.Count
        }
    }
    $win = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.StartTime -gt $started }
    if ($win) {
        Write-Host ""
        Write-Host " Fenetre ouverte, cette console se ferme."
        Start-Sleep -Milliseconds 700
        exit 0
    }
    if ($child.HasExited) {
        Write-Host ""
        Write-Host " Le lancement s'est arrete avant l'ouverture de la fenetre (voir ci-dessus / logs\dev.log)."
        exit 1
    }
    $spin++
    if ($seen -eq 0 -and $spin % 10 -eq 0) { Write-Host (" ... demarrage ({0} s)" -f [int]((Get-Date) - $started).TotalSeconds) }
    Start-Sleep -Milliseconds 400
}
