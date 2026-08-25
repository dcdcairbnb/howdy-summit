#!/bin/bash
# Howdy Summit - push the already-made commit to GitHub so Vercel deploys.
#
# The commit (76693ef) is already made locally: socials removed, header
# collapse on phones, tighter bottom bars, sw.js at v6. Only the push is
# left, and that needs your GitHub credentials, which my sandbox does not
# have.
#
# Double-click this. If macOS refuses, right-click > Open.

cd "$(dirname "$0")" || exit 1

echo "=================================================="
echo " Howdy Summit - push to GitHub"
echo " $(pwd)"
echo "=================================================="
echo ""

# Clear the stale lock files my sandbox could not delete.
find .git -maxdepth 3 -name '*.lock' -delete 2>/dev/null
find .git/objects -name 'tmp_obj_*' -delete 2>/dev/null

echo "About to push:"
git log --oneline -1
echo ""
echo "Unpushed commits:"
git log --oneline origin/main..main 2>/dev/null || echo "  (could not compare to origin)"
echo ""

if git push origin main; then
  echo ""
  echo "Pushed. Vercel is building."
  echo "Live in 30 to 90 seconds: https://www.howdysummitcounty.com"
  echo ""
  echo "sw.js is bumped to v6, but if the old footer sticks in your"
  echo "browser, hard-refresh once with Cmd+Shift+R."
else
  echo ""
  echo "Push failed."
  echo "If it asked for a username, run 'gh auth login' first, then"
  echo "double-click this again."
fi

echo ""
echo "Press Return to close."
read -r _
