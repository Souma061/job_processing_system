# start-cluster.ps1
# Usage: .\start-cluster.ps1 -Workers 3 -BasePort 3000

param(
    [int]$Workers = 3,
    [int]$BasePort = 3000
)

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  Starting Job Processing Cluster: $Workers Server Instances  " -ForegroundColor Yellow
Write-Host "=====================================================" -ForegroundColor Cyan

for ($i = 0; $i -lt $Workers; $i++) {
    $port = $BasePort + $i
    $workerTitle = "Server-Worker Port $port"

    Write-Host "[+] Launching $workerTitle in separate window..." -ForegroundColor Green

    # Start a new PowerShell terminal running this server instance on its respective PORT
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle = '$workerTitle'; `$env:PORT=$port; pnpm run dev"

    # Brief pause between launches so database init doesn't collide
    Start-Sleep -Milliseconds 800
}

Write-Host "`nAll $Workers worker terminals launched successfully!" -ForegroundColor Cyan
Write-Host "All instances are connected to shared Redis (127.0.0.1:6379) and Neon DB." -ForegroundColor Gray
Write-Host "Endpoints live from port $BasePort to $($BasePort + $Workers - 1)`n" -ForegroundColor White
