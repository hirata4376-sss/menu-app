@echo off
chcp 65001>nul
cd /d "%~dp0"
echo ===== デプロイ開始 ===== > deploy_log.txt
echo %date% %time% >> deploy_log.txt
echo. >> deploy_log.txt
npx vercel --prod --yes >> deploy_log.txt 2>&1
echo. >> deploy_log.txt
echo ===== 終了コード: %errorlevel% ===== >> deploy_log.txt
echo.
echo 完了しました。deploy_log.txt を確認してください。
pause
