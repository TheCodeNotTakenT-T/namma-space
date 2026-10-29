@echo off
cd /d "%~dp0"
python -X utf8 viewer\scripts\namma-pipeline.py %*
if errorlevel 1 pause
