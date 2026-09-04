# Creates Desktop + Start Menu shortcuts so OSIRIS opens like any installed app.
# Re-running is safe - it overwrites the existing shortcuts in place.
$ErrorActionPreference = 'Stop'

$AppRoot  = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot 'OASIS-VISION.cmd'
$Icon     = Join-Path $PSScriptRoot 'oasis-vision.ico'

if (-not (Test-Path $Launcher)) { Write-Error "Launcher missing: $Launcher"; exit 1 }

# The .ico is a build artifact generated from public/oasis-icon.png, so it is
# gitignored and absent on a fresh clone. Build it rather than silently falling
# back to upstream's favicon, which is the old eye-of-Horus mark.
if (-not (Test-Path $Icon)) {
  $maker = Join-Path $PSScriptRoot 'make-icon.ps1'
  if (Test-Path $maker) { & powershell -NoProfile -ExecutionPolicy Bypass -File $maker }
}
if (-not (Test-Path $Icon))     { $Icon = Join-Path $AppRoot 'public\favicon.ico' }

$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'OASIS VISION.lnk'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\OASIS VISION.lnk')
)

$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
  $dir = Split-Path -Parent $t
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $sc = $shell.CreateShortcut($t)
  $sc.TargetPath       = "$env:SystemRoot\System32\cmd.exe"
  # /c runs the launcher and exits; the server itself is started detached by the ps1.
  $sc.Arguments        = "/c `"$Launcher`""
  $sc.WorkingDirectory = $AppRoot
  $sc.IconLocation     = "$Icon,0"
  $sc.Description      = 'OASIS VISION - Global Intelligence & Reconnaissance'
  $sc.WindowStyle      = 7            # start minimized - the app window is the real UI
  $sc.Save()
  Write-Host "Created: $t" -ForegroundColor Green
}

Write-Host ""
Write-Host "OASIS VISION is installed. Launch it from the Desktop or the Start Menu." -ForegroundColor Cyan
