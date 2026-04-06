@echo off
REM Claude Code Discord Bot 자동 재시작 설정 스크립트 (Windows Task Scheduler)
REM 매일 정해진 시간에 봇을 자동으로 재시작하여 Claude Code 토큰 갱신

setlocal enabledelayedexpansion

echo 🤖 Claude Code Discord Bot 자동 재시작 설정 ^(Windows^)
echo =====================================================
echo.

REM 1. 봇 경로 자동 감지
cd /d "%~dp0\.."
set "BOT_DIR=%cd%"
echo ✅ 봇 디렉토리: %BOT_DIR%
echo.

REM 2. 재시작 시간 입력 (기본값: 새벽 2시)
set "RESTART_TIME=02:00"
set /p "RESTART_TIME=자동 재시작 시간을 입력하세요 ^(시:분, 기본값 02:00^): "

REM 시간과 분 파싱
for /f "tokens=1,2 delims=:" %%a in ("%RESTART_TIME%") do (
  set "HOUR=%%a"
  set "MINUTE=%%b"
)

if not defined MINUTE set "MINUTE=00"

REM 앞의 0 제거 (예: 02 -> 2)
for /f %%a in ("!HOUR!") do set "HOUR=%%a"
for /f %%a in ("!MINUTE!") do set "MINUTE=%%a"

echo ⏰ 매일 !HOUR!:!MINUTE!에 봇을 재시작합니다
echo.

REM 3. Task Scheduler에 작업 등록
echo 🔧 Windows Task Scheduler에 작업 등록 중...
set "TASK_NAME=Claude-Discord-Bot-AutoRestart"

REM 기존 작업 삭제
taskkill /f /im node.exe 2>nul

REM PowerShell로 Task Scheduler 작업 생성
powershell -NoProfile -Command ^
  "$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c taskkill /f /im node.exe ^& timeout /t 3 ^& cd /d \"%BOT_DIR%\" ^& npm start'; " ^
  "$trigger = New-ScheduledTaskTrigger -Daily -At '!HOUR!:!MINUTE!'; " ^
  "$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest; " ^
  "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RunOnlyIfNetworkAvailable:$false; " ^
  "$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Auto-restart Claude Code Discord Bot daily to refresh token'; " ^
  "Register-ScheduledTask -TaskName 'Claude-Discord-Bot-AutoRestart' -InputObject $task -Force"

if !errorlevel! equ 0 (
  echo ✅ Task Scheduler 작업 등록 완료
  echo 📍 작업 이름: %TASK_NAME%
  echo 📍 시간: !HOUR!:!MINUTE! ^(매일^)
) else (
  echo ❌ Task Scheduler 작업 등록 실패
  echo 관리자 권한이 필요합니다. 명령 프롬프트를 관리자 권한으로 실행 후 다시 시도하세요.
  pause
  exit /b 1
)

REM 4. 검증
echo.
echo 🔍 설정 검증 중...
schtasks /query /tn "%TASK_NAME%" >nul 2>&1
if !errorlevel! equ 0 (
  echo ✅ Task Scheduler 작업이 활성화되었습니다
  echo.
  echo 작업 상세정보:
  schtasks /query /tn "%TASK_NAME%" /v /fo list
) else (
  echo ⚠️  Task Scheduler 작업을 확인할 수 없습니다
)

echo.
echo 📋 설정 완료!
echo.
echo 언제든지 비활성화할 수 있습니다:
echo   schtasks /delete /tn "%TASK_NAME%" /f
echo.
echo ⚠️  주의:
echo   - npm start가 실행되어야 하므로 npm이 PATH에 있어야 합니다
echo   - 매일 !HOUR!:!MINUTE!에 자동으로 봇이 종료 후 재시작됩니다
echo   - 로그는 Event Viewer에서 확인할 수 있습니다 ^(응용 프로그램 및 서비스 로그^)
echo.

pause
