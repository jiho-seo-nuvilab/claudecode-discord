#!/bin/bash
# Claude Code Discord Bot 자동 재시작 설정 스크립트
# 매일 정해진 시간에 봇을 자동으로 재시작하여 Claude Code 토큰 갱신

set -e

echo "🤖 Claude Code Discord Bot 자동 재시작 설정"
echo "============================================"

# 1. 봇 경로 확인
BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "✅ 봇 디렉토리: $BOT_DIR"

# 2. 재시작 시간 입력 (기본값: 새벽 2시)
read -p "자동 재시작 시간을 입력하세요 (시:분, 기본값 02:00): " RESTART_TIME
RESTART_TIME="${RESTART_TIME:-02:00}"
IFS=':' read HOUR MINUTE <<< "$RESTART_TIME"
HOUR=$((10#$HOUR))
MINUTE=$((10#$MINUTE))

echo "⏰ 매일 $HOUR:$MINUTE에 봇을 재시작합니다"

# 3. 운영 체제 감지 및 설정
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo "🍎 macOS 감지 - launchd 설정 중..."
  
  PLIST_PATH="$HOME/Library/LaunchAgents/com.claude.discord-bot.restart.plist"
  
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude.discord-bot.restart</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>pkill -f "node.*index.js" || true; sleep 3; cd "$BOT_DIR" && npm start 2>&1 | tee -a ~/.claude/bot-restart.log &</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$HOME/.claude/bot-restart.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.claude/bot-restart-error.log</string>
</dict>
</plist>
EOF
  
  # launchd 로드
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
  
  echo "✅ launchd 에이전트 등록 완료"
  echo "📍 설정 파일: $PLIST_PATH"
  
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  echo "🐧 Linux 감지 - crontab 설정 중..."
  
  CRON_CMD="$HOUR $MINUTE * * * pkill -f 'node.*index.js' || true; sleep 3; cd $BOT_DIR && npm start >> ~/.claude/bot-restart.log 2>&1 &"
  
  # 기존 항목 제거
  crontab -l 2>/dev/null | grep -v "discord-bot\|claudecode-discord" | crontab - 2>/dev/null || true
  
  # 새 항목 추가
  (crontab -l 2>/dev/null || true; echo "# Claude Discord Bot Auto-restart"; echo "$CRON_CMD") | crontab -
  
  echo "✅ crontab 항목 등록 완료"
  
else
  echo "❌ 지원하지 않는 OS입니다"
  exit 1
fi

# 4. 검증
echo ""
echo "🔍 설정 검증 중..."

if [[ "$OSTYPE" == "darwin"* ]]; then
  if launchctl list | grep -q "com.claude.discord-bot.restart"; then
    echo "✅ launchd 에이전트가 활성화되었습니다"
  else
    echo "⚠️  launchd 에이전트를 확인할 수 없습니다"
  fi
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  if crontab -l 2>/dev/null | grep -q "discord-bot\|claudecode-discord"; then
    echo "✅ crontab이 등록되었습니다"
    echo ""
    echo "현재 설정:"
    crontab -l 2>/dev/null | grep "discord-bot\|claudecode-discord"
  fi
fi

echo ""
echo "📋 설정 완료!"
echo ""
echo "명령어로 언제든지 비활성화할 수 있습니다:"
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo "  launchctl unload ~/Library/LaunchAgents/com.claude.discord-bot.restart.plist"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  echo "  crontab -e  # 해당 라인 삭제"
fi

echo ""
echo "⚠️  주의:"
echo "  - npm start가 백그라운드에서 실행됩니다"
echo "  - 로그: ~/.claude/bot-restart.log"
echo "  - Discord 봇이 실행 중이면 자동으로 종료 후 재시작됩니다"
