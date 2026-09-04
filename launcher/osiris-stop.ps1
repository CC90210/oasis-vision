# Stops only the node process serving OSIRIS on its port - never a stray node app.
param([int]$Port = 3177)
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) { Write-Host "OSIRIS is not running on port $Port." -ForegroundColor Yellow; exit 0 }
foreach ($c in $conns) {
  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') {
    Write-Host "Stopping OSIRIS (PID $($p.Id))..." -ForegroundColor Cyan
    Stop-Process -Id $p.Id -Force
  } else {
    Write-Host "Port $Port is held by '$($p.ProcessName)' (PID $($p.Id)) - not OSIRIS. Leaving it alone." -ForegroundColor Yellow
  }
}
