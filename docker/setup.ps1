# Downloads and imports a Debian rootfs as a local Docker image.
# This bypasses Docker Hub's zstd-compressed layers entirely.
$RootfsUrl = "https://github.com/debuerreotype/docker-debian-artifacts/raw/dist-amd64/bookworm/rootfs.tar.xz"
$ImageName = "geniesh-base:latest"
$Tarball = "$env:TEMP\debian-rootfs.tar.xz"

Write-Host "=== Downloading Debian rootfs (xz compressed, ~30 MB) ==="
curl.exe -L -o $Tarball $RootfsUrl
if (-not $?) { throw "Download failed" }

Write-Host "=== Importing as Docker image '$ImageName' ==="
docker import $Tarball $ImageName
if (-not $?) { throw "Import failed" }

Remove-Item $Tarball -Force

Write-Host "=== Image ready ==="
docker images $ImageName
Write-Host ""
Write-Host "Now run: docker compose build geniesh && docker compose up -d"
