#!/usr/bin/env pwsh
# Thin launcher for Windows/PowerShell. Prefers the compiled build; falls back to tsx for development.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $here 'dist/cli.js'
if (Test-Path $cli) {
  & node $cli @args
  exit $LASTEXITCODE
}
if (Test-Path (Join-Path $here 'node_modules/tsx')) {
  & node --import tsx (Join-Path $here 'src/cli.ts') @args
  exit $LASTEXITCODE
}
Write-Error "symphony: no dist/cli.js found. Run 'npm install; npm run build' in $here"
exit 4