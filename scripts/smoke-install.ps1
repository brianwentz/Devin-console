<#
.SYNOPSIS
  Installed-artifact smoke for Agent Workspace (plan §5 P3).

  1. Silently installs the NSIS installer per-user into -InstallDir
  2. Runs tests/smoke/installed.spec.ts (phase=fresh) against the installed exe
  3. Re-runs the same installer over the existing install (upgrade-in-place)
  4. Runs the smoke spec again (phase=upgrade) and asserts the profile survived
  5. Silently uninstalls and asserts the install dir is gone

  Modes:
    -Isolated  smoke a separately-packaged build ("Agent Workspace Smoke",
               appId io.github.brianwentz.agent-workspace.smoke, dist\smoke\AgentWorkspace-Smoke-Setup-*.exe).
               Default for `npm run smoke:install` — safe while the real app is installed/running.
    (none)     smoke the real artifact (dist\AgentWorkspace-Setup-*.exe). CI uses
               `npm run smoke:install:real` on a clean runner. Refuses to run locally
               when a non-smoke install of the same product is registered or running,
               because NSIS uninstalls the old version regardless of /D=.
    -From <old-installer.exe>  cross-rename smoke (implies -Isolated): installs the
               pre-rename smoke build at its own default dir, launches it once to
               write a legacy profile, then runs the new smoke installer with
               /S --updated exactly as electron-updater does and asserts the new
               identity (dir, registry, shortcuts) plus the profile migration.
               Only ever touches the two *Smoke* dirs — never Programs\Devin
               Workspaces or Programs\Agent Workspace. Logs to
               docs\evidence\p3-smoke-rename.log.
    -Force     bypass the guardrails (never set from package.json).

  No admin required (perMachine=false). Logs go to docs\evidence\p3-smoke.log.
#>
[CmdletBinding()]
param(
  [string]$Installer,
  [string]$InstallDir,
  [string]$ProfileDir = (Join-Path $env:TEMP 'agent-workspace-smoke-profile'),
  [string]$LogFile,
  [string]$From,
  [switch]$Isolated,
  [switch]$Force,
  [switch]$SkipUpgrade
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root

# -From = cross-rename smoke: install the pre-rename smoke build, then run the
# new installer silently (as electron-updater does). Always isolated; the new
# installer's own default dir is Programs\Agent Workspace Smoke.
if ($From) { $Isolated = $true }
if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\agent-workspace-smoke'
  if ($From) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Agent Workspace Smoke' }
}
if (-not $LogFile) {
  $LogFile = Join-Path $root 'docs\evidence\p3-smoke.log'
  if ($From) { $LogFile = Join-Path $root 'docs\evidence\p3-smoke-rename.log' }
}
New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
Remove-Item -Force -ErrorAction SilentlyContinue $LogFile

$ProductName = if ($Isolated) { 'Agent Workspace Smoke' } else { 'Agent Workspace' }
$InstallerGlob = if ($Isolated) { 'AgentWorkspace-Smoke-Setup-*.exe' } else { 'AgentWorkspace-Setup-*.exe' }
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
# "Agent Workspace Smoke 1.0.2" can never match "Agent Workspace 1.1.0".
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
$env:AGENT_WORKSPACE_SMOKE_INSTALLER_SIZE = "$size"
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

$env:AGENT_WORKSPACE_INSTALLED_EXE = $exe
$env:AGENT_WORKSPACE_SMOKE_PROFILE = $ProfileDir
$env:AGENT_WORKSPACE_SMOKE_EVIDENCE = $evidenceDir

$failed = $false
try {
  if ($From) {
    # --- cross-rename smoke -------------------------------------------------
    # Install the pre-rename smoke build, then run the new installer with
    # /S --updated and no /D= — exactly what electron-updater does.
    $From = (Resolve-Path $From).Path
    $OldProductName = 'Devin Workspaces Smoke'
    $OldInstallDir = Join-Path $env:LOCALAPPDATA "Programs\$OldProductName"
    $OldExe = Join-Path $OldInstallDir "$OldProductName.exe"
    $SmokeGuid = '8bc73818-13fb-5883-bfb3-62006ae4a564'
    Log "From: $From"
    Log "OldInstallDir: $OldInstallDir"
    # Hard guard: the only dirs this flow installs/uninstalls into are the two
    # *Smoke* dirs — the real 'Devin Workspaces' / 'Agent Workspace' installs
    # ($LOCALAPPDATA\Programs\<productName>) are never referenced.
    $realDirs = @(
      (Join-Path $env:LOCALAPPDATA 'Programs\Devin Workspaces'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Agent Workspace')
    )
    if (($realDirs -contains $OldInstallDir) -or ($realDirs -contains $InstallDir)) {
      Fail "rename smoke would touch a real install dir (old='$OldInstallDir' new='$InstallDir')"
    }

    # Clean slate for BOTH smoke identities.
    foreach ($dir in @($OldInstallDir, $InstallDir)) {
      $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) })
      if ($procs.Count -gt 0) {
        Log "Killing $($procs.Count) process(es) under $dir"
        $procs | Stop-Process -Force
        Start-Sleep -Seconds 2
      }
      $un = Get-ChildItem $dir -Filter 'Uninstall *.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($un) {
        Log "Pre-clean uninstall: $($un.FullName)"
        Start-Process -FilePath $un.FullName -ArgumentList @('/S', '/currentuser', "_?=$dir") -Wait | Out-Null
      }
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $dir
    }

    # 1. Install the OLD installer silently — no /D=, lands at its default dir.
    Log "install (old): `"$From`" /S /currentuser"
    $proc = Start-Process -FilePath $From -ArgumentList @('/S', '/currentuser') -Wait -PassThru
    if ($proc.ExitCode -ne 0) { Fail "old install exit code $($proc.ExitCode)" }
    if (-not (Test-Path $OldExe)) { Fail "old exe not found at $OldExe" }
    Log "Old install landed at $OldInstallDir"

    # 2. Launch the old exe once (legacy env names) so it writes a real profile.
    $oldProfile = Join-Path $ProfileDir 'old'
    $env:DEVIN_WORKSPACES_USER_DATA = $oldProfile
    $env:DEVIN_WORKSPACES_TEST = '1'
    $oldProc = Start-Process -FilePath $OldExe -PassThru
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Path (Join-Path $oldProfile 'settings.json')) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path (Join-Path $oldProfile 'settings.json'))) {
      Fail 'old smoke app did not write settings.json within 60 s'
    }
    Stop-Process -Id $oldProc.Id -Force -ErrorAction SilentlyContinue
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($OldInstallDir, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
    $oldPartition = Join-Path $oldProfile 'Partitions\devin'
    New-Item -ItemType Directory -Force -Path $oldPartition | Out-Null
    'keep' | Set-Content (Join-Path $oldPartition 'marker.txt')
    Remove-Item Env:\DEVIN_WORKSPACES_USER_DATA, Env:\DEVIN_WORKSPACES_TEST -ErrorAction SilentlyContinue
    Log "Old profile staged at $oldProfile (Partitions\devin\marker.txt planted)"

    # 3. New installer as the updater would run it: silent, no /D=.
    Log "update install (new): `"$Installer`" /S --updated"
    $proc = Start-Process -FilePath $Installer -ArgumentList @('/S', '--updated') -Wait -PassThru
    if ($proc.ExitCode -ne 0) { Fail "update install exit code $($proc.ExitCode)" }

    if (-not (Test-Path $exe)) { Fail "new exe not found at $exe" }
    if (Test-Path $OldInstallDir) { Fail "old install dir still present: $OldInstallDir" } else { Log "Old install dir removed: $OldInstallDir" }
    $reg = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$SmokeGuid" -ErrorAction SilentlyContinue
    if (-not $reg -or $reg.DisplayName -notmatch '^Agent Workspace Smoke \d') {
      Fail "uninstall DisplayName mismatch: '$($reg.DisplayName)'"
    }
    Log "Uninstall registry: key='$SmokeGuid' DisplayName='$($reg.DisplayName)' DisplayVersion='$($reg.DisplayVersion)'"
    $installLocation = (Get-ItemProperty "HKCU:\Software\$SmokeGuid" -ErrorAction SilentlyContinue).InstallLocation
    Log "InstallLocation: $installLocation"
    if ($installLocation -ne $InstallDir) { Fail "InstallLocation '$installLocation' != '$InstallDir'" }

    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $desktop = [Environment]::GetFolderPath('Desktop')
    $staleLinks = @(
      @(Get-ChildItem $startMenu -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue),
      @(Get-ChildItem $desktop -Filter '*.lnk' -ErrorAction SilentlyContinue)
    ) | Where-Object { $_.Name -like '*Devin Workspaces Smoke*' }
    if ($staleLinks) { Fail "stale shortcut(s) left behind: $($staleLinks.FullName -join '; ')" }
    $newLink = @(Get-ChildItem $startMenu -Recurse -Filter 'Agent Workspace Smoke.lnk' -ErrorAction SilentlyContinue)
    if ($newLink.Count -eq 0) { Fail "no 'Agent Workspace Smoke.lnk' under $startMenu" }
    Log "Shortcut: $($newLink[0].FullName)"

    # 4. Smoke spec against the new exe; the app itself migrates the staged
    # profile (MIGRATE_FROM → spec forwards it; profile dir must not exist).
    $newProfile = Join-Path $ProfileDir 'new'
    $env:AGENT_WORKSPACE_SMOKE_PROFILE = $newProfile
    $env:AGENT_WORKSPACE_TEST_MIGRATE_FROM = $oldProfile
    $env:AGENT_WORKSPACE_SMOKE_PHASE = 'fresh'
    Log 'Running smoke spec (phase=fresh, cross-rename)'
    & npx playwright test --config playwright.smoke.config.ts 2>&1 | ForEach-Object { Add-Content -Path $LogFile -Value $_; Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { Fail "smoke spec failed with exit code $LASTEXITCODE" }
    Assert-NoApp

    if (-not (Test-Path (Join-Path $newProfile 'settings.json'))) { Fail 'settings.json missing in migrated profile' }
    if (Test-Path $oldProfile) { Fail "old profile dir still present: $oldProfile" } else { Log "Old profile dir moved: $oldProfile" }
    if (-not (Test-Path (Join-Path $newProfile 'Partitions\cloud\marker.txt'))) { Fail 'Partitions\cloud\marker.txt missing after migration' }
    $eventsText = Get-Content (Join-Path $newProfile 'events.jsonl') -Raw -ErrorAction SilentlyContinue
    if ($eventsText -notmatch 'profile-migrated') { Fail 'events.jsonl has no profile-migrated entry' }
    Log 'Profile migration verified: profile-migrated logged, marker moved to Partitions\cloud'
  } else {
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
  $env:AGENT_WORKSPACE_SMOKE_PHASE = 'fresh'
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

    $env:AGENT_WORKSPACE_SMOKE_PHASE = 'upgrade'
    Log 'Running smoke spec (phase=upgrade)'
    & npx playwright test --config playwright.smoke.config.ts 2>&1 | ForEach-Object { Add-Content -Path $LogFile -Value $_; Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { Fail "smoke spec (upgrade) failed with exit code $LASTEXITCODE" }
    Assert-NoApp
  }
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
  Remove-Item Env:\AGENT_WORKSPACE_INSTALLED_EXE, Env:\AGENT_WORKSPACE_SMOKE_PROFILE, Env:\AGENT_WORKSPACE_SMOKE_EVIDENCE, Env:\AGENT_WORKSPACE_SMOKE_PHASE, Env:\AGENT_WORKSPACE_SMOKE_INSTALLER_SIZE, Env:\AGENT_WORKSPACE_TEST_MIGRATE_FROM, Env:\DEVIN_WORKSPACES_USER_DATA, Env:\DEVIN_WORKSPACES_TEST -ErrorAction SilentlyContinue
}

if ($failed) { Log 'RESULT: FAIL'; exit 1 }
Log 'RESULT: PASS'
exit 0
