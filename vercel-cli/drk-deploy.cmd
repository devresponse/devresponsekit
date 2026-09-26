@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  drk-deploy — deploy devresponsekit to Vercel from a Windows command prompt.
rem
rem  Call it from anywhere by absolute path, or add this folder to PATH:
rem      C:\my\repos\devresponsekit\vercel-cli\drk-deploy.cmd up
rem
rem  Arguments reach node as cmd.exe parses them, and no batch file can undo
rem  that (F-143). From cmd.exe, a value inside double quotes keeps & and ^.
rem  From PowerShell they do not survive: PowerShell drops the quotes around
rem  an argument with no space, and cmd.exe parses the line before this file
rem  runs, so & starts a second command, ^ disappears and %VAR% expands.
rem  From PowerShell, run node "<this folder>\dist\index.js" for such a value.
rem  Never pass a secret as an argument at all: run drk-deploy login (its
rem  prompt hides the token) or set VERCEL_TOKEN, and set the migration URL
rem  as PRODUCTION_DIRECT_DATABASE_URL (a satellite:
rem  SATELLITE_DIRECT_DATABASE_URL), in the environment or the --from-env file.
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
