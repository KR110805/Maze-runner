@echo off
title ACM Maze Game Server (Port 3000)
cd /d "%~dp0"
echo Starting ACM Maze Game Server...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
