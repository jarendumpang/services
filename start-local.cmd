@echo off
setlocal
cd /d "%~dp0"
set "TRIGO_NODE="

rem Prefer a normal Node.js installation so application updates do not break it.
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined TRIGO_NODE set "TRIGO_NODE=%%N"
if defined TRIGO_NODE goto run

rem Use the saved executable only if it still exists.
if exist .node-path set /p TRIGO_NODE=<.node-path
if defined TRIGO_NODE if exist "%TRIGO_NODE%" goto run
set "TRIGO_NODE="

rem A Codex runtime update can move its bundled Node executable.
for /f "delims=" %%N in ('powershell -NoProfile -Command "Get-ChildItem -Path ($env:ProgramFiles + '\WindowsApps\OpenAI.CodexPrimaryRuntime.*\dependencies\node\bin\node.exe') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName"') do if not defined TRIGO_NODE set "TRIGO_NODE=%%N"
if defined TRIGO_NODE goto run

echo Node.js was not found. Install Node.js 22 or 24, then open this launcher again.
pause
exit /b 1

:run
echo Starting the TriGo face matcher. Keep this window open while using the app.
"%TRIGO_NODE%" server.cjs
if errorlevel 1 echo The matcher stopped. Check the message above before trying again.
pause
endlocal
