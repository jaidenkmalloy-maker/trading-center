<# : batch portion (this file is both a Windows batch file and a PowerShell script)
@echo off
title Installing Trading Control Center
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([IO.File]::ReadAllText('%~f0'))"
echo.
pause
exit /b
#>
$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $repo = 'https://raw.githubusercontent.com/jaidenkmalloy-maker/trading-center/main/'
  $dest = Join-Path $env:LOCALAPPDATA 'TradingCenter'
  Write-Host ''
  Write-Host 'Installing Trading Control Center into' $dest
  Write-Host ''

  # 1. Node.js
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js is missing. Installing it (this can take a minute)...'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Start-Process 'https://nodejs.org/'; throw 'Please install Node.js (LTS) from the page that just opened, then run this installer again.' }
  }
  Write-Host 'Node.js found:' (node -v)

  # 2. Download the app and check every file
  New-Item -ItemType Directory -Force -Path (Join-Path $dest 'app') | Out-Null
  $vfile = Join-Path $dest 'version.json.download'
  Invoke-WebRequest -UseBasicParsing ($repo + 'version.json') -OutFile $vfile
  $v = Get-Content -Raw $vfile | ConvertFrom-Json
  foreach ($f in $v.files.PSObject.Properties) {
    $out = Join-Path $dest ($f.Name -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
    Write-Host '  downloading' $f.Name
    Invoke-WebRequest -UseBasicParsing ($repo + $f.Name) -OutFile $out
    $h = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $f.Value) { throw "The download of $($f.Name) did not pass its safety check. Please run the installer again." }
  }
  Move-Item -Force $vfile (Join-Path $dest 'version.json')
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText((Join-Path $dest 'config.json'), "{`r`n  `"port`": 7457,`r`n  `"updateUrl`": `"$($repo)version.json`"`r`n}`r`n", $utf8)

  # 3. The start file, kept next to the app
  $bat = @"
@echo off
title Trading Control Center (keep this window open)
cd /d "%~dp0"
if not exist "server.js" (
  echo The app files are not in this folder. Run "Install Trading Center" again.
  pause
  exit /b
)
node server.js
echo.
echo The app has stopped. Close this window, or press a key.
pause >nul
"@
  [IO.File]::WriteAllText((Join-Path $dest 'Start Trading Center.bat'), ($bat -replace "`r?`n", "`r`n"), $utf8)

  # 4. Desktop shortcut
  $desk = [Environment]::GetFolderPath('Desktop')
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path $desk 'Trading Center.lnk'))
  $lnk.TargetPath = Join-Path $dest 'Start Trading Center.bat'
  $lnk.WorkingDirectory = $dest
  $lnk.Description = 'Trading Control Center'
  $nodeExe = (Get-Command node).Source
  if ($nodeExe) { $lnk.IconLocation = "$nodeExe,0" }
  $lnk.Save()

  # 5. Tidy up the start file that was copied to the Desktop on its own (only if it is ours)
  $stray = Join-Path $desk 'Start Trading Center.bat'
  if ((Test-Path $stray) -and ((Get-Content -Raw $stray) -match 'node server\.js')) { Remove-Item -Force $stray; Write-Host 'Removed the old start file from the Desktop.' }

  Write-Host ''
  Write-Host 'Done. A "Trading Center" icon is now on your Desktop.' -ForegroundColor Green
  Write-Host 'Starting the app now...'
  Start-Process -FilePath (Join-Path $dest 'Start Trading Center.bat') -WorkingDirectory $dest
} catch {
  Write-Host ''
  Write-Host ('Something went wrong: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'Send a screenshot of this window to Claude.'
}
