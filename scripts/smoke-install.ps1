<#
.SYNOPSIS
  Installed-artifact smoke for Devin Workspaces (plan §5 P3).

  1. Silently installs the NSIS installer per-user into -InstallDir
  2. Runs tests/smoke/installed.spec.ts (phase=fresh) against the installed exe
  3. Re-runs the same installer over the existing install (upgrade-in-place)
  4. Runs the smoke spec again (phase=upgrade) and asserts the profile survived
  5. Silently uninstalls and asserts the install dir is gone

  Modes:
    -Isolated  smoke a separately-packaged build ("Devin Workspaces Smoke",
               appId ai.devin.workspaces.smoke, dist\smoke\DevinWorkspaces-Smoke-Setup-*.exe).
               Default for `npm run smoke:install` — safe while the real app is installed/running.
    (none)     smoke the real artifact (dist\DevinWorkspaces-Setup-*.exe). CI uses
               `npm run smoke:install:real` on a clean runner. Refuses to run locally
               when a non-smoke install of the same product is registered or running,
               because NSIS uninstalls the old version regardless of /D=.
    -Force     bypass the guardrails (never set from package.json).

  No admin required (perMachine=false). Logs go to docs\evidence\p3-smoke.log.
#>
[CmdletBinding()]
param(
  [string]$Installer,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\devin-workspaces-smoke'),
  [string]$ProfileDir = (Join-Path $env:TEMP 'devin-workspaces-smoke-profile'),
  [string]$LogFile,
  [switch]$Isolated,
  [switch]$Force,
  [switch]$SkipUpgrade
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root
if (-not $LogFile) { $LogFile = Join-Path $root 'docs\evidence\p3-smoke.log' }
New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
Remove-Item -Force -ErrorAction SilentlyContinue $LogFile

$ProductName = if ($Isolated) { 'Devin Workspaces Smoke' } else { 'Devin Workspaces' }
$InstallerGlob = if ($Isolated) { 'DevinWorkspaces-Smoke-Setup-*.exe' } else { 'DevinWorkspaces-Setup-*.exe' }
$InstallerDir = if ($Isolated) { 'dist\smoke' } else { 'dist' }

function Log([string]$message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffK'), $message
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}

function Fail([string]$message) { Log "FAIL: $message"; throw $message }

function Run-Installer([string]$exe, [string]$dir, [string]$label) {
  # electron-builder NSIS: /S silent, /currentuser forces per-user, /D= must be last and unquoted.
  $args = @('/S', '/currentuser', "/D=$dir")
  Log "$label`: `"$exe`" $($args -join ' ')"
  $proc = Start-Process -FilePath $exe -ArgumentList $args -Wait -PassThru
  Log "$label exit code: $($proc.ExitCode)"
  if ($proc.ExitCode -ne 0) { Fail "$label failed with exit code $($proc.ExitCode)" }
}

# electron-builder keys the per-user uninstall entry by a GUID derived from appId and names it
# "<productName> <version>", so match "Name <digits>" exactly — in isolated mode
# "Devin Workspaces Smoke 1.0.2" can never match "Devin Workspaces 1.1.0".
function Get-UninstallEntry() {
  $pattern = "^$([regex]::Escape($ProductName)) \d"
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName -match $pattern } |
    Select-Object -First 1
}

function Get-SmokeProcesses() {
  # Only processes whose executable lives under the smoke install dir — never
  # touch a same-named process from a real install.
  Get-Process -Name $ProductName -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) }
}

function Get-ForeignProcesses() {
  Get-Process -Name $ProductName -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and -not $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) }
}

function Assert-NoApp() {
  $procs = @(Get-SmokeProcesses)
  if ($procs.Count -gt 0) {
    Log "Killing $($procs.Count) leftover '$ProductName' smoke process(es) under $InstallDir"
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
}

# --- guardrails -----------------------------------------------------------
# NSIS uninstalls the old version before installing: installUtil reads
# HKCU\Software\<APP_GUID>\InstallLocation (the registry, not /D=). If a real
# install of $ProductName exists outside our smoke dir, running this script
# would silently uninstall it.
if (-not $Force) {
  $foreign = Get-UninstallEntry
  if ($foreign -and $foreign.UninstallString -notlike "*$InstallDir\*") {
    Fail "A non-smoke install of '$ProductName' is registered at $($foreign.UninstallString); the NSIS installer would uninstall it. Use npm run smoke:install (isolated) instead."
  }
  $foreignProcs = @(Get-ForeignProcesses)
  if ($foreignProcs.Count -gt 0) {
    Fail "'$ProductName' is running from outside $InstallDir ($($foreignProcs.Count) process(es)); the smoke run could touch it. Use npm run smoke:install (isolated) instead."
  }
}

# --- locate installer --------------------------------------------------------
if (-not $Installer) {
  $candidates = Get-ChildItem -Path (Join-Path $root $InstallerDir) -Filter $InstallerGlob -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  if (-not $candidates) { Fail "No $InstallerDir\$InstallerGlob found; run $(if ($Isolated) { 'npm run dist:win:smoke' } else { 'npm run dist:win' }) first" }
  $Installer = $candidates[0].FullName
}
$Installer = (Resolve-Path $Installer).Path
$size = (Get-Item $Installer).Length
Log "Installer: $Installer ($([math]::Round($size / 1MB, 2)) MB, $size bytes)"
# Size budget: real installers measure ~127 MB (Phase 7 re-measure). The gate
# exists to catch the 249 MB @anthropic-ai/claude-agent-sdk-<platform> binary
# leaking into the package, so 180 MB leaves headroom for growth while any
# leak still fails loudly.
if ($size -gt 180MB) { Fail "Installer exceeds the 180 MB budget: $size bytes" }
$env:DEVIN_WORKSPACES_SMOKE_INSTALLER_SIZE = "$size"
Log "Mode: $(if ($Isolated) { 'isolated' } else { 'real' }) ProductName: '$ProductName'"
Log "InstallDir: $InstallDir"
Log "Profile: $ProfileDir"
Log "Machine: $env:COMPUTERNAME, user: $env:USERNAME, elevated: $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"

# --- clean slate -------------------------------------------------------------
Assert-NoApp
if (Test-Path $InstallDir) {
  $existingUninstaller = Join-Path $InstallDir "Uninstall $ProductName.exe"
  if (Test-Path $existingUninstaller) {
    Log "Found previous install; uninstalling first"
    Start-Process -FilePath $existingUninstaller -ArgumentList @('/S', '/currentuser', "_?=$InstallDir") -Wait | Out-Null
  }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $InstallDir
}
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $ProfileDir
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$exe = Join-Path $InstallDir "$ProductName.exe"
$uninstaller = Join-Path $InstallDir "Uninstall $ProductName.exe"
$evidenceDir = Join-Path $root 'docs\evidence'

$env:DEVIN_WORKSPACES_INSTALLED_EXE = $exe
$env:DEVIN_WORKSPACES_SMOKE_PROFILE = $ProfileDir
$env:DEVIN_WORKSPACES_SMOKE_EVIDENCE = $evidenceDir

$failed = $false
try {
  # --- install -------------------------------------------------------------
  Run-Installer $Installer $InstallDir 'install'
  if (-not (Test-Path $exe)) { Fail "installed exe not found at $exe" }
  if (-not (Test-Path $uninstaller)) { Fail "uninstaller not found at $uninstaller" }
  $installedFiles = (Get-ChildItem -Recurse -File $InstallDir | Measure-Object -Property Length -Sum)
  Log "Installed: $($installedFiles.Count) files, $([math]::Round($installedFiles.Sum / 1MB, 2)) MB"
  $reg = Get-UninstallEntry
  if ($reg) { Log "Uninstall registry: key='$($reg.PSChildName)' DisplayName='$($reg.DisplayName)' DisplayVersion='$($reg.DisplayVersion)' UninstallString='$($reg.UninstallString)'" }
  else { Fail "No HKCU uninstall entry with DisplayName '$ProductName' found" }

  # --- smoke: fresh --------------------------------------------------------
  $env:DEVIN_WORKSPACES_SMOKE_PHASE = 'fresh'
  Log 'Running smoke spec (phase=fresh)'
  & npx playwright test --config playwright.smoke.config.ts 2>&1 | ForEach-Object { Add-Content -Path $LogFile -Value $_; Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { Fail "smoke spec (fresh) failed with exit code $LASTEXITCODE" }
  Assert-NoApp
  if (-not (Test-Path (Join-Path $ProfileDir 'settings.json'))) { Fail 'settings.json missing after fresh smoke' }

  if (-not $SkipUpgrade) {
    # --- upgrade in place --------------------------------------------------
    Run-Installer $Installer $InstallDir 'upgrade-in-place'
    if (-not (Test-Path $exe)) { Fail "installed exe missing after upgrade at $exe" }
    if (-not (Test-Path (Join-Path $ProfileDir 'settings.json'))) { Fail 'settings.json did not survive upgrade-in-place' }
    Log 'Profile survived upgrade-in-place (settings.json present)'

    $env:DEVIN_WORKSPACES_SMOKE_PHASE = 'upgrade'
    Log 'Running smoke spec (phase=upgrade)'
    & npx playwright test --config playwright.smoke.config.ts 2>&1 | ForEach-Object { Add-Content -Path $LogFile -Value $_; Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { Fail "smoke spec (upgrade) failed with exit code $LASTEXITCODE" }
    Assert-NoApp
  }
}
catch {
  $failed = $true
  Log "ERROR: $($_.Exception.Message)"
}
finally {
  # --- uninstall -----------------------------------------------------------
  Assert-NoApp
  if (Test-Path $uninstaller) {
    # _?= makes the uninstaller run in place (so -Wait is accurate) instead of copying itself to %TEMP%.
    Log "uninstall: `"$uninstaller`" /S /currentuser _?=$InstallDir"
    $proc = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser', "_?=$InstallDir") -Wait -PassThru
    Log "uninstall exit code: $($proc.ExitCode)"
    # With _?= the uninstaller cannot delete itself; remove the (now empty-ish) dir it leaves behind.
    Start-Sleep -Seconds 1
    $leftovers = Get-ChildItem -Recurse -File $InstallDir -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "Uninstall $ProductName.exe" }
    if ($leftovers) {
      Log "FAIL: files left after uninstall: $($leftovers.FullName -join '; ')"
      $failed = $true
    }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $InstallDir
  }
  if (Test-Path $InstallDir) { Log "FAIL: install dir still present: $InstallDir"; $failed = $true }
  else { Log "Install dir removed: $InstallDir" }
  $regAfter = Get-UninstallEntry
  if ($regAfter) { Log 'FAIL: uninstall registry key still present'; $failed = $true } else { Log 'Uninstall registry key removed' }
  $profileSurvived = Test-Path (Join-Path $ProfileDir 'settings.json')
  Log "Profile retained after uninstall (deleteAppDataOnUninstall=false; smoke profile is env-overridden): $profileSurvived"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $ProfileDir
  Remove-Item Env:\DEVIN_WORKSPACES_INSTALLED_EXE, Env:\DEVIN_WORKSPACES_SMOKE_PROFILE, Env:\DEVIN_WORKSPACES_SMOKE_EVIDENCE, Env:\DEVIN_WORKSPACES_SMOKE_PHASE, Env:\DEVIN_WORKSPACES_SMOKE_INSTALLER_SIZE -ErrorAction SilentlyContinue
}

if ($failed) { Log 'RESULT: FAIL'; exit 1 }
Log 'RESULT: PASS'
exit 0
