#!/bin/bash
# Howdy Summit - one-time iOS project setup.
# Double-click in Finder, or run:  bash SETUP_IOS.command
#
# Installs Capacitor, bundles the web app into www/, creates the native
# ios/ Xcode project, and opens it. Safe to re-run; it skips steps already done.

cd "$(dirname "$0")" || exit 1

echo "=================================================="
echo " Howdy Summit - iOS setup"
echo " $(pwd)"
echo "=================================================="
echo ""

# ---- prerequisites -------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed."
  echo "Install it from https://nodejs.org (LTS), then re-run this script."
  echo ""; echo "Press Return to close."; read -r _; exit 1
fi
echo "node $(node -v),  npm $(npm -v)"

if ! xcode-select -p >/dev/null 2>&1; then
  echo ""
  echo "ERROR: Xcode command line tools not found."
  echo "Run:  xcode-select --install"
  echo ""; echo "Press Return to close."; read -r _; exit 1
fi
echo "Xcode tools: $(xcode-select -p)"
echo ""

# ---- clear any stale git locks so this never blocks later -----------------
find .git -name '*.lock' -maxdepth 3 -delete 2>/dev/null

# ---- 1. install Capacitor ------------------------------------------------
echo "--------------------------------------------------"
echo " 1/5  Installing Capacitor"
echo "--------------------------------------------------"
if [ ! -d node_modules/@capacitor/core ]; then
  npm install @capacitor/core@latest @capacitor/cli@latest @capacitor/ios@latest || {
    echo "npm install failed."; echo "Press Return to close."; read -r _; exit 1; }
else
  echo "Capacitor already installed, skipping."
fi

# Native plugins the web app already reaches for. These are what make this a
# real app rather than a wrapped website, which matters for App Store review.
echo ""
echo "Installing native plugins (geolocation, share, haptics, status bar, splash)..."
npm install \
  @capacitor/geolocation@latest \
  @capacitor/share@latest \
  @capacitor/haptics@latest \
  @capacitor/status-bar@latest \
  @capacitor/splash-screen@latest \
  @capacitor/app@latest \
  @capacitor-community/speech-recognition@latest || echo "  (some plugins failed; continuing)"

# ---- 2. build www/ -------------------------------------------------------
echo ""
echo "--------------------------------------------------"
echo " 2/5  Bundling web app into www/"
echo "--------------------------------------------------"
bash scripts/build-www.sh || { echo "build-www failed."; echo "Press Return to close."; read -r _; exit 1; }

# ---- 3. add the iOS platform --------------------------------------------
echo ""
echo "--------------------------------------------------"
echo " 3/5  Creating the native iOS project"
echo "--------------------------------------------------"
if [ -d ios ]; then
  echo "ios/ already exists, skipping cap add."
else
  npx cap add ios || { echo "cap add ios failed."; echo "Press Return to close."; read -r _; exit 1; }
fi

# ---- 4. sync -------------------------------------------------------------
echo ""
echo "--------------------------------------------------"
echo " 4/5  Syncing web assets + plugins into Xcode"
echo "--------------------------------------------------"
npx cap sync ios || { echo "cap sync failed."; echo "Press Return to close."; read -r _; exit 1; }

# ---- 5. Info.plist permission strings ------------------------------------
# iOS crashes on launch if a permission is used without a usage description.
PLIST="ios/App/App/Info.plist"
if [ -f "$PLIST" ]; then
  echo ""
  echo "--------------------------------------------------"
  echo " 5/5  Adding privacy usage descriptions"
  echo "--------------------------------------------------"
  add_plist() {
    /usr/libexec/PlistBuddy -c "Add :$1 string '$2'" "$PLIST" 2>/dev/null \
      && echo "  added $1" \
      || echo "  $1 already present"
  }
  add_plist NSLocationWhenInUseUsageDescription "Howdy Summit uses your location to show the closest restaurants, apres-ski bars, and trailheads, set an accurate rideshare pickup, and place you on the map when you join a group."
  add_plist NSMicrophoneUsageDescription "Howdy Summit uses the microphone so you can ask questions by voice instead of typing."
  add_plist NSSpeechRecognitionUsageDescription "Howdy Summit converts your spoken question into text so the concierge can answer it."
fi

echo ""
echo "=================================================="
echo " Setup complete."
echo ""
echo " Opening Xcode. In Xcode you still need to:"
echo "   1. Select the App target > Signing & Capabilities"
echo "   2. Choose your Apple Developer team"
echo "   3. Set the app icon from ios-assets/AppIcon-1024.png"
echo "   4. Pick a device or simulator and press Run"
echo ""
echo " After any change to index.html, run:"
echo "   npm run ios:sync"
echo "=================================================="
echo ""

npx cap open ios || echo "Could not auto-open Xcode. Open ios/App/App.xcworkspace manually."

echo ""
echo "Press Return to close."
read -r _
