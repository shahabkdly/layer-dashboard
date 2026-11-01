@echo off
rem Layer dashboard in your web browser, with nothing installed: starts a small web server
rem that is built into Windows (see serve.ps1) and opens the dashboard. Close this window to stop.
title Layer dashboard
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*
if errorlevel 1 pause
