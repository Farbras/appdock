$ErrorActionPreference = 'Stop'
$npmCliPath = Join-Path $PSScriptRoot '..\.tools\package\bin\npm-cli.js'
if (-not (Test-Path $npmCliPath)) { throw 'Установите Node.js с npm или выполните scripts/bootstrap.ps1.' }
$env:PATH = "$PSScriptRoot;$env:PATH"
& node $npmCliPath @args
exit $LASTEXITCODE
