#!/bin/bash
# Assembles the www/ folder that Capacitor bundles into the iOS app.
#
# The web app is a single index.html plus a few static assets. Capacitor needs
# them collected in one directory (webDir in capacitor.config.json), so this
# copies the current versions in. Re-run any time index.html changes, then
# `npx cap sync ios` to push them into the Xcode project.

set -e
cd "$(dirname "$0")/.." || exit 1

WWW="www"

echo "Rebuilding $WWW/ ..."
# Overwrite in place rather than rm -rf. Deleting the directory fails on
# sandboxed/synced mounts that allow writes but not unlinks, and it silently
# left a stale index.html behind. Copying over the top always works.
mkdir -p "$WWW"

# Core app
cp index.html      "$WWW/"
cp manifest.json   "$WWW/"

# Images referenced by the UI
cp logo.png        "$WWW/" 2>/dev/null || true
cp logo.jpg        "$WWW/" 2>/dev/null || true
cp app-icon.png    "$WWW/" 2>/dev/null || true
cp og-image.png    "$WWW/" 2>/dev/null || true

# The downloadable 3-day cheat sheet, if present
cp cheatsheet.pdf  "$WWW/" 2>/dev/null || true

# NOTE: sw.js is deliberately NOT copied. index.html skips service worker
# registration inside the native shell, since the assets are already local
# and the SW's navigation handler fights WKWebView.

echo ""
echo "Contents of $WWW/:"
ls -la "$WWW"
echo ""
echo "Done. Next: npx cap sync ios"
