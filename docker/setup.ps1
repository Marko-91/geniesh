# Downloads Alpine minirootfs into the project root (build context) so the
# Dockerfile can ADD it using Go's built-in tar/gzip — no containerd zstd.

$Url = "https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.3-x86_64.tar.gz"
$Out = "..\alpine-minirootfs.tar.gz"

Write-Host "=== Downloading Alpine rootfs (~3 MB) ==="
curl.exe -L -o $Out $Url
if (-not $?) { throw "Download failed" }

Write-Host "=== Done! ==="
Write-Host "Rootfs saved as: $Out"
Write-Host ""
Write-Host "Now run: docker compose build geniesh --no-cache && docker compose up -d"
