#!/bin/bash
# Creates "~/Applications/MacPiP (Dev).app": a double-clickable launcher that
# quits any running MacPiP and starts this checkout's source (like `npm start`).
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$PROJECT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
APP="$HOME/Applications/MacPiP (Dev).app"

if [ ! -x "$ELECTRON" ]; then
  echo "Electron not found. Run 'npm install' in $PROJECT first." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/launcher.applescript" <<APPLESCRIPT
set projectDir to "$PROJECT"
set electronBin to "$ELECTRON"
try
	do shell script "test -x " & quoted form of electronBin
on error
	display alert "MacPiP (Dev)" message "Electron was not found in " & projectDir & ". Run npm install there first." as critical
	return
end try
-- Only one MacPiP can run at a time, so stop the installed app or an older dev run first.
-- Match exact process name / command start only, so unrelated processes mentioning these paths survive.
do shell script "pkill -x 'MacPiP' ; pkill -f " & quoted form of ("^" & electronBin & " ") & " ; true"
delay 1
-- Background only the Electron command (not a subshell holding stdout), so the applet exits right away.
do shell script "cd " & quoted form of projectDir & "; nohup " & quoted form of electronBin & " . > /tmp/macpip-dev.log 2>&1 < /dev/null &"
APPLESCRIPT

mkdir -p "$HOME/Applications"
rm -rf "$APP"
osacompile -o "$APP" "$TMP/launcher.applescript"

# Use the project's icon.
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$PROJECT/build/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$PROJECT/build/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"

xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
touch "$APP"

echo "Created: $APP"
echo "Logs from dev runs go to /tmp/macpip-dev.log"
