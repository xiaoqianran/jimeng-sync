@echo off
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
echo Opening Jimeng collector gallery...
node scripts\launch.js
pause
