# Build symphony and drop it into <project>/.symphony/ (gitignored).
#   ./install.ps1 -Target C:\path\to\project
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Target
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path -LiteralPath $Target)) { throw "install.ps1: target not found: $Target" }
$target = (Resolve-Path -LiteralPath $Target).Path
$dest = Join-Path $target '.symphony'

Write-Host "building symphony in $here"
Push-Location $here
try {
  npm install --no-audit --no-fund --silent
  npm run build --silent
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Remove-Item -Recurse -Force (Join-Path $dest 'dist') -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force (Join-Path $here 'dist') (Join-Path $dest 'dist')
foreach ($f in @('symphony', 'symphony.ps1', 'symphony.cmd', 'README.md', 'symphony.config.example.json')) {
  Copy-Item -Force (Join-Path $here $f) $dest
}
Set-Content -Path (Join-Path $dest 'package.json') -Value "{`n  `"name`": `"symphony`",`n  `"type`": `"module`",`n  `"private`": true`n}`n"
Set-Content -Path (Join-Path $dest '.gitignore') -Value "*`n"

$cfg = Join-Path $dest 'symphony.config.json'
if (-not (Test-Path -LiteralPath $cfg)) { Copy-Item (Join-Path $here 'symphony.config.example.json') $cfg }

$gi = Join-Path $target '.gitignore'
$hasEntry = (Test-Path -LiteralPath $gi) -and ((Get-Content -LiteralPath $gi) -contains '.symphony/')
if (-not $hasEntry) {
  Add-Content -Path $gi -Value "`n# symphony harness (local tool, not tracked)`n.symphony/`n"
  Write-Host "added .symphony/ to $gi"
}

Write-Host "installed to $dest"
Write-Host "next: cd $target; ./.symphony/symphony.ps1 init; ./.symphony/symphony.ps1 doctor"