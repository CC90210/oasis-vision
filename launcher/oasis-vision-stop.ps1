# Stops only the node process serving OASIS VISION on its port - never a stray node app.
param([int]$Port = 3177)
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) { Write-Host "OASIS VISION is not running on port $Port." -ForegroundColor Yellow; exit 0 }
foreach ($c in $conns) {
  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') {
    Write-Host "Stopping OASIS VISION (PID $($p.Id))..." -ForegroundColor Cyan
    Stop-Process -Id $p.Id -Force
  } else {
    Write-Host "Port $Port is held by '$($p.ProcessName)' (PID $($p.Id)) - not OASIS VISION. Leaving it alone." -ForegroundColor Yellow
  }
}
