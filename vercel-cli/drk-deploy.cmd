@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  drk-deploy — deploy devresponsekit to Vercel from a Windows command prompt.
rem
rem  Call it from anywhere by absolute path, or add this folder to PATH:
rem      C:\my\repos\devresponsekit\vercel-cli\drk-deploy.cmd up
rem
rem  Works in cmd.exe and PowerShell. Arguments are forwarded verbatim, so a
rem  connection string containing & or ^ survives (quote it at the call site).
rem ---------------------------------------------------------------------------

if not exist "%~dp0dist\index.js" (
  echo drk-deploy is not built yet.
  echo.
  echo   cd /d "%~dp0"
  echo   pnpm install
  echo   pnpm build
  echo.
  exit /b 1
)

node "%~dp0dist\index.js" %*
exit /b %ERRORLEVEL%
