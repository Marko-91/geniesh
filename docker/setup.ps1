# Downloads Alpine minirootfs directly from Alpine's CDN (gzip, not zstd)
# and imports it as a local Docker image — completely bypassing Docker Hub.

$RootfsUrl = "https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.3-x86_64.tar.gz"
$ImageName = "geniesh-base:latest"
$Tarball = "$env:TEMP\alpine-rootfs.tar.gz"

Write-Host "=== Cleaning old images ==="
docker rmi geniesh-base:latest -f 2>$null

Write-Host "=== Downloading Alpine minirootfs (~3 MB, gzip) ==="
curl.exe -L -o $Tarball $RootfsUrl
if (-not $?) { throw "Download failed" }

Write-Host "=== Importing as Docker image '$ImageName' ==="
docker import $Tarball $ImageName
if (-not $?) { throw "Import failed" }

Remove-Item $Tarball -Force

Write-Host "=== Image ready ==="
docker images $ImageName
Write-Host ""
Write-Host "Now run: docker compose build geniesh --no-cache && docker compose up -d"
