#!/bin/bash
# Installs (or removes) the Reddit monitor as a macOS LaunchAgent: runs every 3 hours
# while you're logged in, and once more on wake if a run was missed while asleep.
#
#   ./install-mac.sh            install or update
#   ./install-mac.sh uninstall  remove
#   ./install-mac.sh run        run once now in this terminal (to test)
#   ./install-mac.sh login      open Chrome on the monitor's own profile to log in to Reddit (once)
#   ./install-mac.sh check      one Reddit page through that Chrome: does reading work?
set -euo pipefail

LABEL="com.reviewtactic.reddit-monitor"
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/reddit-monitor.log"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed. Log kept at $LOG"
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js not found. Install it first (https://nodejs.org, version 18 or newer)." >&2
  exit 1
fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "Node $MAJOR is too old; version 18 or newer is needed." >&2
  exit 1
fi

if [ ! -f "$DIR/.env" ]; then
  echo "Missing $DIR/.env. Copy .env.example to .env and fill in RM_SECRET first." >&2
  exit 1
fi
chmod 600 "$DIR/.env"

# Browser helper (playwright-core drives the installed Google Chrome; it downloads no browser).
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
WANT="$("$NODE" -p 'require(process.argv[1]).dependencies["playwright-core"]' "$DIR/package.json" 2>/dev/null || true)"
HAVE="$("$NODE" -p 'require(process.argv[1]).version' "$DIR/node_modules/playwright-core/package.json" 2>/dev/null || true)"
if [ "$WANT" != "$HAVE" ]; then
  if [ -z "$NPM" ]; then echo "npm not found (it comes with Node.js)." >&2; exit 1; fi
  echo "Installing the browser helper (one time, ~10 MB)..."
  (cd "$DIR" && "$NPM" install --omit=dev --no-audit --no-fund --loglevel=error)
fi
if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "$HOME/Applications/Google Chrome.app" ]; then
  echo "Google Chrome not found in Applications. Install it from google.com/chrome first." >&2
  exit 1
fi

if [ "${1:-}" = "login" ]; then
  exec "$NODE" "$DIR/scraper.mjs" login
fi

if [ "${1:-}" = "check" ]; then
  exec "$NODE" "$DIR/scraper.mjs" check
fi

if [ "${1:-}" = "run" ]; then
  exec "$NODE" "$DIR/scraper.mjs"
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/scraper.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartInterval</key><integer>10800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed. First run starts now, then every 3 hours."
echo "Log: tail -f $LOG"
