@echo off
rem launch.cmd - the installed pendpost entry point (Start-menu + optional startup).
rem
rem Starts the bundled Node server in the background, then opens the dashboard as a
rem chromeless Edge "app" window. Re-running is safe: a second server instance sees
rem the port in use and exits cleanly (server.mjs handles EADDRINUSE), so the first
rem keeps serving. The server writes all state under PENDPOST_ROOT (%APPDATA%\
rem pendpost), never the read-only install dir.
setlocal
set "PENDPOST_ROOT=%APPDATA%\pendpost"
set "PENDPOST_PORT=8090"

rem Background server, no console window. %~dp0 is the install dir (trailing \).
start "" /b "%~dp0runtime\node.exe" "%~dp0runtime\scripts\desktop-start.mjs"

rem Give it a moment to bind, then open the dashboard. Prefer a chromeless Edge app
rem window (present on every Win10/11); fall back to the default browser.
timeout /t 2 /nobreak >nul
start "" msedge --app=http://127.0.0.1:8090 || start "" http://127.0.0.1:8090
endlocal
