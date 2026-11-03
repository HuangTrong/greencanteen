@echo off
rem Tai va chuan bi moi thu he thong can, bam dup de chay. Chay lai nhieu lan an toan. Tham so: xem dau tep tools\setup.mjs
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Chua co Node.js. Cai Node.js 20 tro len tu https://nodejs.org roi chay lai tep nay.
  pause
  exit /b 1
)
node tools\setup.mjs %*
set RESULT=%errorlevel%
pause
exit /b %RESULT%
