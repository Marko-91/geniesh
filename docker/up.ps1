docker compose up -d ollama
Write-Host "Waiting for Ollama to be healthy..."
while ((docker inspect --format='{{.State.Health.Status}}' geniesh-ollama) -ne 'healthy') {
  Start-Sleep -Seconds 2
}
Write-Host "Ollama is ready!"
docker compose run --rm --service-ports geniesh
