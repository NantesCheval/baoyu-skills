#!/bin/bash
PORT=9222
PROFILE="$HOME/.local/share/wechat-browser-profile"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL="https://mp.weixin.qq.com/"

# Check if already running on the desired port
if curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "Chrome already running on port $PORT ✓"
  exit 0
fi

# Check if Chrome is already running with this profile on a different port
EXISTING_PORT=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i chrome | awk '{print $9}' | sed 's/.*://' | while read p; do
  if curl -s "http://127.0.0.1:$p/json/version" >/dev/null 2>&1; then
    # Check if it's using our profile
    ps aux | grep -v grep | grep "user-data-dir=$PROFILE" | grep "remote-debugging-port=$p" >/dev/null 2>&1 && echo "$p" && break
  fi
done)

if [ -n "$EXISTING_PORT" ]; then
  echo "Chrome already running with this profile on port $EXISTING_PORT"
  echo "Closing it first to relaunch on port $PORT..."
  # Send close via CDP
  curl -s "http://127.0.0.1:$EXISTING_PORT/json/close" >/dev/null 2>&1
  # Kill the Chrome process using this profile
  pkill -f "user-data-dir=$PROFILE"
  sleep 2
fi

mkdir -p "$PROFILE"

echo "Starting Chrome on debug port $PORT..."
echo "Profile: $PROFILE"

"$CHROME" \
  --remote-debugging-port=$PORT \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-blink-features=AutomationControlled \
  "$URL" &

disown

# Wait for port to be ready
for i in $(seq 1 15); do
  if curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "Chrome ready on port $PORT ✓"
    echo "Please scan QR code to log in. Keep this Chrome window open."
    exit 0
  fi
  sleep 1
done

echo "Warning: Chrome started but port $PORT not responding yet. Check the browser window."
