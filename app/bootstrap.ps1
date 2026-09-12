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
& $nodeExe (Join-Path $PSScriptRoot 'install.mjs') --auto-import
if ($LASTEXITCODE -ne 0) { throw 'Application installation failed' }
$skillConfig = Join-Path $env:USERPROFILE '.codex\skills\dsh-dialogue\connection.local.json'
& $nodeExe (Join-Path $PSScriptRoot 'setup-key.mjs') $skillConfig
if ($LASTEXITCODE -ne 0) { throw 'Model credential setup was not completed' }
& $nodeExe (Join-Path $PSScriptRoot 'launch.mjs') --config $skillConfig --restart-owned --open
if ($LASTEXITCODE -ne 0) { throw 'Application startup needs attention; see the reported reason' }
