$ErrorActionPreference = "Stop"
$env:PATH = "$PSScriptRoot\.tools\node-v22.14.0-win-x64;$env:PATH"

Write-Host "Starting SatellitePlanner Full Stack (NATS JetStream + Backend API + Vite 3D Globe Frontend)..." -ForegroundColor Cyan
& "$PSScriptRoot\.tools\node-v22.14.0-win-x64\node.exe" "$PSScriptRoot\run-stack.mjs"
