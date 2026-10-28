param([switch]$Build)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
. (Join-Path $PSScriptRoot 'build-env.ps1')
if (Test-Path '.tools\cargo\bin\cargo.exe') {
  $env:CARGO_HOME = Join-Path (Get-Location) '.tools\cargo'
  $env:RUSTUP_HOME = Join-Path (Get-Location) '.tools\rustup'
  $env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
}
$npmCliPath = Join-Path (Get-Location) '.tools\package\bin\npm-cli.js'
$env:PATH = "$PSScriptRoot;$env:PATH"
if ($Build) { & node $npmCliPath run bundle } else { & node $npmCliPath run desktop }
exit $LASTEXITCODE
