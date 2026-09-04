<#
  OASIS VISION launcher.

  Starts the standalone Next.js server and opens a chromeless application window
  (its own taskbar icon, no browser UI). Safe to run twice: if the server is
  already up it just re-opens the window.

  -Lan  binds the server to every interface so a phone on the same Wi-Fi can
        reach it, and prints the URL to open. Off by default: this dashboard
        proxies arbitrary external URLs and runs a recon toolkit, so it should
        not be reachable from the network unless you deliberately ask for it.
#>
param(
  [int]$Port = 3177,
  [switch]$NoWindow,   # start the server only, don't open a UI window
  [switch]$Lan         # expose on the local network (for phone / tablet access)
)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
$Server  = Join-Path $AppRoot '.next\standalone\server.js'
$LogDir  = Join-Path $AppRoot 'launcher\logs'
$Url     = "http://127.0.0.1:$Port"

if (-not (Test-Path $Server)) {
  Write-Host "OASIS VISION is not built yet. Run launcher\rebuild.cmd first." -ForegroundColor Red
  Read-Host "Press Enter to close"; exit 1
}
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Test-Up {
  try { return (Invoke-WebRequest -Uri "$Url/api/health" -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200 }
  catch { return $false }
}

function Get-LanIP {
  # Prefer a real RFC1918 address. Picking the first non-loopback address
  # returned 100.126.120.46 - the Tailscale CGNAT interface - and printed it as
  # the Wi-Fi URL, which no phone on the LAN can reach.
  try {
    $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' }
    $private = $addrs | Where-Object { $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' }
    if ($private) { return ($private | Sort-Object -Property SkipAsSource | Select-Object -First 1).IPAddress }
    return ($addrs | Sort-Object -Property SkipAsSource | Select-Object -First 1).IPAddress
  } catch { return $null }
}

function Get-TailscaleHost {
  # Tailscale, when present, is the better phone answer than the LAN: it works
  # off the home network and `tailscale serve` fronts it with a real HTTPS cert,
  # which Safari requires for Add-to-Home-Screen and for geolocation.
  try {
    $exe = 'C:\Program Files\Tailscale\tailscale.exe'
    if (-not (Test-Path $exe)) { return $null }
    $st = & $exe status --json 2>$null | ConvertFrom-Json
    if ($st.BackendState -ne 'Running') { return $null }
    return ($st.Self.DNSName -replace '\.$', '')
  } catch { return $null }
}

# A server already bound to loopback cannot serve the LAN, so -Lan has to
# restart it rather than reuse it.
$running = Test-Up
if ($running -and $Lan) {
  $boundAll = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
              Where-Object { $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' }
  if (-not $boundAll) {
    Write-Host "Restarting on all interfaces for LAN access..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot 'osiris-stop.ps1') -Port $Port | Out-Null
    Start-Sleep -Seconds 2
    $running = $false
  }
}

if ($running) {
  Write-Host "OASIS VISION already running on $Url" -ForegroundColor Green
} else {
  $bind = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
  Write-Host "Starting OASIS VISION on port $Port (bind $bind)..." -ForegroundColor Cyan
  $stamp = Get-Date -Format 'yyyy-MM-dd'
  $env:PORT     = "$Port"
  $env:HOSTNAME = $bind
  $env:NODE_ENV = 'production'

  Start-Process -FilePath 'node' -ArgumentList "`"$Server`"" `
    -WorkingDirectory (Split-Path -Parent $Server) `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "oasis-vision-$stamp.log") `
    -RedirectStandardError  (Join-Path $LogDir "oasis-vision-$stamp.err.log")

  $ok = $false
  foreach ($i in 1..45) { Start-Sleep -Milliseconds 700; if (Test-Up) { $ok = $true; break } }
  if (-not $ok) {
    Write-Host "Server did not come up in 30s. Check launcher\logs\." -ForegroundColor Red
    Read-Host "Press Enter to close"; exit 1
  }
  Write-Host "OASIS VISION is live." -ForegroundColor Green
}

if ($Lan) {
  $ip = Get-LanIP
  $ts = Get-TailscaleHost
  Write-Host ""
  if ($ts) {
    Write-Host "  BEST - from anywhere, over Tailscale (HTTPS, private to your devices):" -ForegroundColor Green
    Write-Host "    https://$ts" -ForegroundColor Yellow
    Write-Host "    Requires: Tailscale app on the phone, same account, and" -ForegroundColor DarkGray
    Write-Host "    'tailscale serve --bg $Port' run once on this machine." -ForegroundColor DarkGray
    Write-Host ""
  }
  if ($ip) {
    Write-Host "  Same Wi-Fi only (plain HTTP):  http://${ip}:$Port" -ForegroundColor Yellow
    # HTTP is why this is the fallback: Safari withholds geolocation and
    # Add-to-Home-Screen behaves as a bookmark on an insecure origin.
    Write-Host "    Note: on plain HTTP, Safari will not give the page your GPS." -ForegroundColor DarkGray
  } else {
    Write-Host "  Could not determine this machine's LAN IP - run 'ipconfig'." -ForegroundColor Red
  }
  # The first LAN launch usually trips the Windows firewall prompt; say so rather
  # than letting the phone silently time out.
  $fw = Get-NetFirewallRule -DisplayName 'OASIS VISION' -ErrorAction SilentlyContinue
  if (-not $fw) {
    Write-Host "  If the phone cannot connect, allow the port once (run as Administrator):" -ForegroundColor DarkGray
    Write-Host "    New-NetFirewallRule -DisplayName 'OASIS VISION' -Direction Inbound -LocalPort $Port -Protocol TCP -Action Allow -Profile Private" -ForegroundColor DarkGray
  }
  Write-Host ""
}

if ($NoWindow) { exit 0 }

# Chromeless app window - Edge ships with Windows 11; Chrome is the fallback.
$browsers = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
$browser = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($browser) {
  $profileDir = Join-Path $AppRoot 'launcher\.appwindow'
  Start-Process -FilePath $browser -ArgumentList @(
    "--app=$Url",
    "--user-data-dir=`"$profileDir`"",
    "--window-size=1600,950",
    "--disable-features=Translate,AutofillServerCommunication"
  )
} else {
  Start-Process $Url   # no Edge/Chrome - fall back to the default browser
}
