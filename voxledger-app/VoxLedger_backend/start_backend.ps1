Set-Location $PSScriptRoot
if (-not (Test-Path "venv")) {
    Write-Host "Creating virtual environment..."
    python -m venv venv
}
.\venv\Scripts\Activate.ps1
pip install -q -r requirements.txt
uvicorn main:app --reload --port 8000
