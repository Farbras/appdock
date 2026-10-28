$appDockRoot = Split-Path $PSScriptRoot
$appDockMsvcBase = Join-Path $appDockRoot '.tools\portable-msvc\Contents\VC\Tools\MSVC'
if (Test-Path $appDockMsvcBase) {
  $appDockMsvc = (Get-ChildItem -LiteralPath $appDockMsvcBase -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
  $appDockSdk = Join-Path $appDockRoot '.tools\microsoft.windows.sdk.cpp\c'
  $appDockSdkLib = Join-Path $appDockRoot '.tools\microsoft.windows.sdk.cpp.x64\c'
  $appDockSdkVersion = (Get-ChildItem -LiteralPath (Join-Path $appDockSdk 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
  $env:PATH = "$appDockMsvc\bin\Hostx64\x64;$appDockSdk\bin\$appDockSdkVersion\x64;$env:PATH"
  $env:INCLUDE = "$appDockMsvc\include;$appDockSdk\Include\$appDockSdkVersion\ucrt;$appDockSdk\Include\$appDockSdkVersion\shared;$appDockSdk\Include\$appDockSdkVersion\um;$appDockSdk\Include\$appDockSdkVersion\winrt"
  $env:LIB = "$appDockMsvc\lib\x64;$appDockMsvc\lib\onecore\x64;$appDockSdkLib\um\x64;$appDockSdkLib\ucrt\x64"
  $env:VCToolsInstallDir = "$appDockMsvc\"
  $env:WindowsSdkDir = "$appDockSdk\"
  $env:WindowsSDKVersion = "$appDockSdkVersion\"
  $env:CC = 'cl.exe'
  $env:CXX = 'cl.exe'
  $env:RC = 'rc.exe'
  $env:VSLANG = '1033'
}
if (Test-Path (Join-Path $appDockRoot '.tools\cargo\bin\cargo.exe')) {
  $env:CARGO_HOME = Join-Path $appDockRoot '.tools\cargo'
  $env:RUSTUP_HOME = Join-Path $appDockRoot '.tools\rustup'
  $env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
}
$env:PATH = "$PSScriptRoot;$env:PATH"
