#!/bin/bash
# Trading Control Center - installer for Mac. Run with:
#   curl -fsSL https://raw.githubusercontent.com/jaidenkmalloy-maker/trading-center/main/install-mac.sh | bash
set -e
BASE="${TCC_BASE:-https://raw.githubusercontent.com/jaidenkmalloy-maker/trading-center/main/}"
DEST="${TCC_DEST:-$HOME/TradingCenter}"
DESK="${TCC_DESK:-$HOME/Desktop}"
echo ""
echo "Installing Trading Control Center into $DEST"
echo ""
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed yet."
  echo "Your browser will open nodejs.org: download the LTS version for macOS, open it, click through the installer,"
  echo "then paste the same line into Terminal again."
  (command -v open >/dev/null && open "https://nodejs.org/") || true
  exit 1
fi
echo "Node.js found: $(node -v)"
mkdir -p "$DEST/app"
curl -fsSL "${BASE}version.json?t=$(date +%s)" -o "$DEST/version.json.download"
FILES=$(node -e "const v=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); for (const [f,h] of Object.entries(v.files)) console.log(f+' '+h)" "$DEST/version.json.download")
hashof() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }
while read -r f h; do
  [ -z "$f" ] && continue
  case "$f" in *..*|/*) echo "Refused an unsafe file name: $f"; exit 1;; esac
  echo "  downloading $f"
  mkdir -p "$(dirname "$DEST/$f")"
  curl -fsSL "${BASE}${f}?t=$(date +%s)" -o "$DEST/$f"
  if [ "$(hashof "$DEST/$f")" != "$h" ]; then echo "The download of $f did not pass its safety check. Please run the installer again."; exit 1; fi
done <<< "$FILES"
mv -f "$DEST/version.json.download" "$DEST/version.json"
printf '{\n  "port": 7457,\n  "updateUrl": "%sversion.json"\n}\n' "$BASE" > "$DEST/config.json"
cat > "$DEST/Start Trading Center.command" <<'S'
#!/bin/bash
cd "$(dirname "$0")"
echo "Trading Control Center - keep this window open while it runs."
node server.js
echo ""
echo "The app has stopped. You can close this window."
S
chmod +x "$DEST/Start Trading Center.command"
mkdir -p "$DESK"
ln -sf "$DEST/Start Trading Center.command" "$DESK/Trading Center.command"
echo ""
echo "Done. Double-click \"Trading Center\" on your Desktop to start the app."
echo "Starting it now..."
if [ -z "$TCC_NO_START" ]; then (command -v open >/dev/null && open "$DEST/Start Trading Center.command") || true; fi
