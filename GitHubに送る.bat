@echo off
cd /d "%~dp0"

echo ===== %date% %time% ===== > git_log.txt
if exist .git\index.lock del /f .git\index.lock >> git_log.txt 2>&1
git add . >> git_log.txt 2>&1
git commit -m "update" >> git_log.txt 2>&1
git push --set-upstream origin main >> git_log.txt 2>&1
echo ===== done ===== >> git_log.txt

echo.
type git_log.txt
echo.
pause
