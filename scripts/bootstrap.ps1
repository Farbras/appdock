$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
New-Item -ItemType Directory -Force '.tools' | Out-Null
if (-not (Test-Path '.tools\package\bin\npm-cli.js')) {
  Invoke-WebRequest 'https://registry.npmjs.org/npm/-/npm-11.11.1.tgz' -OutFile '.tools\npm.tgz'
  & "$env:SystemRoot\System32\tar.exe" -xzf '.tools\npm.tgz' -C '.tools'
}
$env:PATH = "$PSScriptRoot;$env:PATH"
& node '.tools\package\bin\npm-cli.js' install
