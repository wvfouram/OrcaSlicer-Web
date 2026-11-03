@echo off
rem Starts the OrcaSlicer-Web server and opens it in your browser.
rem Keep the server window open while you use it; close it to stop the server.
cd /d "%~dp0"
start "OrcaSlicer-Web server" /min "%~dp0OrcaSlicer-Web.exe"
timeout /t 3 /nobreak >nul
start "" http://localhost:8765
