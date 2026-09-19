@echo off
chcp 65001 >nul
cd /d "%~dp0.."

echo.
echo   ===== 牽引ルート =====
echo.
echo   ブラウザで次を開いてください:
echo.
echo       http://localhost:8080/route-scout/
echo.
echo   止めるときはこの窓で Ctrl+C
echo.

python -m http.server 8080 --directory .

echo.
echo   python が見つからない場合は py -m http.server 8080 --directory . を試してください
pause
