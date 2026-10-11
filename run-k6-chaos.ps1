Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "   [PHASE 23] K6 DISTRIBUTED CHAOS ENGINEERING SUITE              " -ForegroundColor Yellow
Write-Host "==================================================================" -ForegroundColor Cyan

# 1. Verify Redis is running in Docker
$redisRunning = docker ps --filter "name=job-processing-redis" --format "{{.Status}}"
if (-not $redisRunning) {
    Write-Host "[ERROR] Redis container 'job-processing-redis' is not running!" -ForegroundColor Red
    Write-Host "Please start it with 'pnpm docker:up'" -ForegroundColor Red
    exit 1
}

# 2. Launch k6 chaos test in background
Write-Host ""
Write-Host "[INIT] Launching k6 chaos traffic generator in Docker..." -ForegroundColor Green
$projectDir = (Get-Location).Path

$job = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    docker compose -f "$dir/docker-compose.yml" run --rm k6 run /scripts/chaos-test.js 2>&1
} -ArgumentList $projectDir

# 3. Stage 1: Baseline load (12s)
Write-Host "[STAGE 1] Measuring baseline traffic under normal conditions (12s)..." -ForegroundColor White
Start-Sleep -Seconds 12

# 4. Stage 2: Chaos Injection (docker pause)
Write-Host ""
Write-Host "[STAGE 2] INJECTING CHAOS -> Freezing Redis (docker pause)..." -ForegroundColor Red
docker pause job-processing-redis
Write-Host "   -> Redis is FROZEN! Network partition / crash simulated." -ForegroundColor DarkYellow
Write-Host "   -> Observing Zero-DB Stale Grace and 503 Fast-Fail Degradation (12s)..." -ForegroundColor DarkYellow
Start-Sleep -Seconds 12

# 5. Stage 3: Recovery (docker unpause)
Write-Host ""
Write-Host "[STAGE 3] SELF-HEALING RECOVERY -> Unpausing Redis (docker unpause)..." -ForegroundColor Green
docker unpause job-processing-redis
Write-Host "   -> Redis UNPAUSED! Observing automatic self-healing..." -ForegroundColor Green

# 6. Wait for k6 to finish and stream output
Write-Host ""
Write-Host "[WAIT] Waiting for k6 to conclude post-recovery validation..." -ForegroundColor Cyan
$output = Receive-Job -Job $job -Wait
Remove-Job -Job $job -Force

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "                     K6 CHAOS TEST RESULTS                        " -ForegroundColor Yellow
Write-Host "==================================================================" -ForegroundColor Cyan
$output | ForEach-Object { Write-Host $_ }
