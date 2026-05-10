# Pre-pulls Alpine base image using classic engine to avoid BuildKit
# zstd extraction issues on some Windows Docker installations.
# Also cleans up any previous corrupt geniesh-base image.

Write-Host "=== Cleaning old corrupt images ==="
docker rmi geniesh-base:latest -f 2>$null

$Image = "alpine:3.20"
Write-Host "=== Pulling $Image (classic engine) ==="
docker pull --platform=linux/amd64 $Image 2>&1
if (-not $?) {
    Write-Host "Trying without --platform..."
    docker pull $Image 2>&1
    if (-not $?) { throw "Pull failed" }
}

Write-Host "=== Ready ==="
docker images $Image
Write-Host ""
Write-Host "Now run: docker compose build geniesh --no-cache && docker compose up -d"
