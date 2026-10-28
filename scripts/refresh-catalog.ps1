$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
foreach ($appDockScript in @('create-catalog.mjs','verify-integrations.mjs','fetch-icons.mjs','polish-data.mjs','add-detection.mjs','enrich-catalog.mjs','verify-catalog.mjs')) {
  & node (Join-Path $PSScriptRoot $appDockScript)
  if ($LASTEXITCODE -ne 0) { throw "Не выполнено: $appDockScript" }
}
