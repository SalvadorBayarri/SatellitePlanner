Write-Host "Stopping SatellitePlanner services (Frontend :5173, Backend :3001, NATS :4222)..." -ForegroundColor Yellow

# Stop NATS Server
Get-Process -Name "nats-server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Stop any processes listening on ports 5173, 3001, 4222, or 8222
$ports = @(5173, 3001, 4222, 8222)
foreach ($port in $ports) {
  $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
  foreach ($conn in $conns) {
    if ($conn.OwningProcess -and $conn.OwningProcess -gt 4) {
      Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "All SatellitePlanner services stopped." -ForegroundColor Green
