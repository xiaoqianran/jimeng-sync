@echo off
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
echo Starting local MySQL sync door on port 3002...
node scripts\launch-remote.js
pause
