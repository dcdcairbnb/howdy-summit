#!/bin/bash
# Howdy Summit - deploy the footer, header and bottom-bar changes.
#
# Why this script exists: the sandbox I work in mounts this folder without
# delete permission, so git could not clear its own stale .git/index.lock.
# Every file change is already written to disk. This clears the lock,
# commits and pushes.
#
# Double-click it. If macOS refuses to run it, right-click > Open.

cd "$(dirname "$0")" || exit 1

echo "=================================================="
echo " Howdy Summit deploy"
echo " $(pwd)"
echo "=================================================="
echo ""

find .git -maxdepth 3 -name '*.lock' -delete 2>/dev/null

echo "Changes to commit:"
git status --short
echo ""

git add index.html public/index.html sw.js

if git diff --cached --quiet; then
  echo "Nothing staged. Already committed?"
else
  git commit -F - <<'MSG'
Drop unclaimed socials, collapse header on phones, tighten bottom bars

Three changes to the chrome around the app, all aimed at giving the
content more of a phone screen.

1. Footer social links removed. TikTok and Instagram pointed at accounts
   that do not exist yet, along with a duplicated separator dot sitting
   between them. The same two URLs were listed in the WebApplication and
   Organization JSON-LD sameAs arrays, which tells Google to go verify
   profiles that will 404. Removed there too. Pinterest is left alone.

2. Header collapses on phones 30 seconds after load. The full header
   (logo, title, "Your Summit County guide" subtitle) earns its space for
   the first few seconds while someone works out what this is. After that
   it is branding sitting on roughly 40px of reading area.

   This uses a new .auto-slim class rather than the existing .slim, which
   matters because goHome() strips .slim: a timed collapse built on it
   would spring back open every time someone tapped Home. The Capacitor
   rule carries the same notch clearance as .slim, or the title slides
   under the Dynamic Island in the iOS shell. Gated on pointer:coarse
   plus max-width 820px so tablets and desktop keep the full header.

3. Bottom bars tightened on phones. Three stacked rows (input, Home,
   disclaimer) were taking about a third of the screen. Padding is down
   across all three and the send/mic buttons went 40px to 36px. The
   disclaimer was the real cost: at 10px with a 12px flex gap, and an
   inline 11px Amazon sentence that was larger than the bar around it,
   it wrapped to three lines on a 390px screen. That inline style is now
   an .amazon-note class so CSS can size it, and a 5px gap pulls the
   whole thing back to one or two lines.

   Nothing was removed. The bottom Home button stays even though the
   header already has one, because thumb reach is worth a row.

sw.js CACHE_VERSION v4 -> v6.
MSG
fi

echo ""
echo "Pushing to origin/main ..."
if git push origin main; then
  echo ""
  echo "Pushed. Vercel is building."
  echo "Live in 30 to 90 seconds: https://www.howdysummitcounty.com"
  echo ""
  echo "The service worker cache is bumped, but if the old footer sticks"
  echo "around in your browser, hard-refresh once (Cmd+Shift+R)."
  git log --oneline -1
else
  echo ""
  echo "Push failed. Run 'git push origin main' and complete any login."
fi

echo ""
echo "Press Return to close."
read -r _
