$ErrorActionPreference = 'Stop'
$appSource = Split-Path -Parent $PSScriptRoot
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe -or (& $nodeExe -p '(()=>{const [a,b]=process.versions.node.split(".").map(Number);return a>22||(a===22&&b>=16)})()') -ne 'true') {
  $version = 'v24.15.0'
  $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
  $name = "node-$version-win-$arch"
  $downloadRoot = Join-Path $env:LOCALAPPDATA 'DSH-Study\node'
  New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
  $zip = Join-Path $downloadRoot "$name.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip
  $sums = (Invoke-WebRequest "https://nodejs.org/dist/$version/SHASUMS256.txt").Content
  $expected = ($sums -split "`n" | Where-Object { $_ -match ([regex]::Escape("$name.zip")+'$') }) -split '\s+' | Select-Object -First 1
  if (-not $expected -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'Official Node archive hash mismatch' }
  Expand-Archive -LiteralPath $zip -DestinationPath $downloadRoot -Force
  $nodeExe = Join-Path $downloadRoot "$name\node.exe"
}
& $nodeExe (Join-Path $PSScriptRoot 'install.mjs') --framework
if ($LASTEXITCODE -ne 0) { throw 'Application installation failed' }
# Basic environment (git, Python 3.12, course-file libraries). Agreed in advance; best effort; never blocks the install.
try {
  $workspace = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DSH-Study'
  $envOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'setup-env.ps1') -Workspace $workspace
  $envLast = ($envOut | Select-Object -Last 1)
  if ($envLast) { $envJson = $envLast | ConvertFrom-Json; foreach ($d in $envJson.path_add) { if ($d -and (Test-Path $d)) { $env:Path = "$d;$env:Path" } }; Write-Host "environment: $envLast" }
} catch { Write-Host "environment setup skipped: $($_.Exception.Message)" }
$skillConfig = Join-Path $env:USERPROFILE '.codex\skills\dsh-dialogue\connection.local.json'
# Records sync to the maintainer's private repo (only if the package carried RECORDS_* settings); best effort.
try { $sync = & $nodeExe (Join-Path $PSScriptRoot 'sync-records.mjs') --config $skillConfig --register-task; Write-Host "records: $sync" } catch { Write-Host "records sync skipped: $($_.Exception.Message)" }
& $nodeExe (Join-Path $PSScriptRoot 'setup-key.mjs') $skillConfig
if ($LASTEXITCODE -ne 0) { throw 'Model credential setup was not completed' }
& $nodeExe (Join-Path $PSScriptRoot 'launch.mjs') --config $skillConfig --restart-owned
if ($LASTEXITCODE -ne 0) { throw 'Application startup needs attention; see the reported reason' }
