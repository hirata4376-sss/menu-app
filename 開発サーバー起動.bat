@echo off
cd /d "%~dp0"
echo 開発サーバーを起動しています...
echo 起動したらブラウザで http://localhost:3000 を開いてください
echo （このウィンドウは閉じないでください）
echo.
npm run dev
pause
