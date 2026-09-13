# Basic environment for a first install (Windows): git, Python 3.12, and the libraries DSH uses to read course files.
# The user has agreed to this in advance; nothing here asks questions. Every step is best-effort and reported.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File setup-env.ps1 [-Workspace <dir>] [-DryRun]
# Prints one JSON line at the end: {git, python, pip, path_add:[...]}.
param([string]$Workspace = '', [switch]$DryRun)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$steps = @()
$pathAdd = @()
$localApp = $env:LOCALAPPDATA
function Step($name, $status, $detail) { $script:steps += [pscustomobject]@{ step = $name; status = $status; detail = "$detail" } }
function Tool($name) { $c = Get-Command $name -ErrorAction SilentlyContinue; if ($c) { return $c.Source } ; return $null }
function AddUserPath($dir) {
  if (-not $dir -or -not (Test-Path $dir)) { return }
  $script:pathAdd += $dir
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $user) { $user = '' }
  if (($user -split ';') -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', ($user.TrimEnd(';') + ';' + $dir).TrimStart(';'), 'User') }
  $env:Path = "$dir;$env:Path"
}
function RealPython() {
  foreach ($cand in @('python', 'python3', 'py')) {
    $src = Tool $cand
    if (-not $src) { continue }
    $out = & $src -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $out -and $out -notmatch 'WindowsApps\\python') { return "$out".Trim() }
  }
  foreach ($p in @("$localApp\Programs\Python\Python312\python.exe", "$localApp\Programs\Python\Python313\python.exe", "$localApp\Programs\Python\Python311\python.exe")) { if (Test-Path $p) { return $p } }
  return $null
}
$winget = Tool 'winget'

# ---- git ----
$git = Tool 'git'
if ($git) { Step 'git' 'present' $git }
elseif ($DryRun) { Step 'git' 'would_install' 'winget Git.Git, fallback MinGit portable' }
else {
  $ok = $false
  if ($winget) {
    & $winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity --silent 2>&1 | Out-Null
    foreach ($d in @("$env:ProgramFiles\Git\cmd", "$localApp\Programs\Git\cmd")) { if (Test-Path "$d\git.exe") { AddUserPath $d; $ok = $true; Step 'git' 'installed_winget' $d; break } }
  }
  if (-not $ok) {
    try {
      $dest = Join-Path $localApp 'DSH-Study\git'
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
      $zip = Join-Path $dest 'MinGit.zip'
      Invoke-WebRequest 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip' -OutFile $zip
      Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
      if (Test-Path "$dest\cmd\git.exe") { AddUserPath "$dest\cmd"; $ok = $true; Step 'git' 'installed_portable' "$dest\cmd" }
    } catch { Step 'git' 'failed' $_.Exception.Message }
  }
  if (-not $ok -and -not ($steps | Where-Object { $_.step -eq 'git' })) { Step 'git' 'failed' 'no installer succeeded' }
}

# ---- python ----
$py = RealPython
if ($py) { Step 'python' 'present' $py }
elseif ($DryRun) { Step 'python' 'would_install' 'winget Python.Python.3.12 --scope user, fallback python.org installer' }
else {
  if ($winget) { & $winget install --id Python.Python.3.12 -e --source winget --scope user --accept-package-agreements --accept-source-agreements --disable-interactivity --silent 2>&1 | Out-Null }
  $py = RealPython
  if (-not $py) {
    try {
      $exe = Join-Path $env:TEMP 'python-3.12.10-amd64.exe'
      Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' -OutFile $exe
      Start-Process -FilePath $exe -ArgumentList '/quiet','InstallAllUsers=0','PrependPath=1','Include_test=0','Include_launcher=0' -Wait
      $py = RealPython
    } catch { Step 'python' 'failed' $_.Exception.Message }
  }
  if ($py) { AddUserPath (Split-Path $py -Parent); AddUserPath (Join-Path (Split-Path $py -Parent) 'Scripts'); Step 'python' 'installed' $py }
  elseif (-not ($steps | Where-Object { $_.step -eq 'python' })) { Step 'python' 'failed' 'no installer succeeded' }
}

# ---- libraries DSH uses to read course files ----
$pkgs = @('python-pptx', 'pypdf', 'python-docx', 'openpyxl')
if ($py -and -not $DryRun) {
  $out = & $py -m pip install --quiet --disable-pip-version-check @pkgs 2>&1
  if ($LASTEXITCODE -eq 0) { Step 'pip' 'installed' ($pkgs -join ', ') } else { Step 'pip' 'failed' ("$out" | Select-Object -Last 1) }
} elseif ($py) { Step 'pip' 'would_install' ($pkgs -join ', ') }
else { Step 'pip' 'skipped' 'no python' }

# ---- report ----
if ($Workspace) {
  try {
    $dir = Join-Path $Workspace 'connection'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $lines = @('# Environment setup', '', "Time: $((Get-Date).ToString('s'))  DryRun: $([bool]$DryRun)", '', '| step | status | detail |', '|---|---|---|')
    foreach ($s in $steps) { $lines += "| $($s.step) | $($s.status) | $($s.detail) |" }
    [IO.File]::WriteAllLines((Join-Path $dir 'ENV-SETUP.md'), $lines, (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
}
$summary = [ordered]@{}
foreach ($s in $steps) { $summary[$s.step] = $s.status }
$summary['path_add'] = @($pathAdd)
Write-Output (ConvertTo-Json $summary -Compress)
