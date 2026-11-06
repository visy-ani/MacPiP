#!/bin/bash
# Build MacPiP and install it to /Applications, replacing any older copy, then relaunch it.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build

ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && DIR="dist/mac" || DIR="dist/mac-$ARCH"
SRC="$DIR/MacPiP.app"
DEST="/Applications/MacPiP.app"

pkill -x MacPiP 2>/dev/null && sleep 1 || true
rm -rf "$DEST"
# ditto without extended attributes keeps the ad-hoc signature valid.
ditto --noextattr "$SRC" "$DEST"
open "$DEST"
echo "Installed and launched $DEST"
