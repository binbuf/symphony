@echo off
rem Thin launcher for Windows cmd/PowerShell. Prefers the compiled build; falls back to tsx.
setlocal
set "HERE=%~dp0"
if exist "%HERE%dist\cli.js" (
  node "%HERE%dist\cli.js" %*
  exit /b %ERRORLEVEL%
)
if exist "%HERE%node_modules\tsx" (
  node --import tsx "%HERE%src\cli.ts" %*
  exit /b %ERRORLEVEL%
)
echo symphony: no dist\cli.js found. Run "npm install" then "npm run build" in %HERE% 1>&2
exit /b 4