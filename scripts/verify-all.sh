#!/usr/bin/env bash
# verify-all.sh - re-confirm every live qID Connect surface in one run.
#
# Point of this script: a handoff document that claims "all green" is only true
# on the day it was written. Run this first, and trust the output over the doc.
#
#   bash skills/qid-connect/scripts/verify-all.sh
#
# Exit 0 = everything a script can check is healthy. Anything else, read the
# output: each line says which surface and what it answered.
#
# It cannot check rendering. If you changed anything that affects the browser
# (CSS, CSP, the widget), open the page and look at it as well - that is the
# failure this suite has already missed once.
#
# SPDX-License-Identifier: MIT

set -uo pipefail
BUN="${BUN:-$HOME/.bun/bin/bun}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECKER="$HERE/check-integration.mjs"
fails=0

say() { printf "%-34s %s\n" "$1" "$2"; }

echo
echo "qID Connect surfaces"
echo "--------------------"
for entry in \
  "https://dashboard.qid.dev|" \
  "https://play.qid.dev|" \
  "https://build.qid.dev|" \
  "https://www.btc2btx.com|"
do
  url="${entry%%|*}"
  out="$("$BUN" "$CHECKER" "$url" 2>&1)"
  code=$?
  score="$(echo "$out" | grep -o '[0-9]*/[0-9]* checks passed')"
  if [ "$code" -eq 0 ]; then
    say "$url" "${score:-ok}"
  else
    say "$url" "FAILED (exit $code) ${score:-}"
    echo "$out" | grep '^FAIL' | sed 's/^/      /'
    fails=$((fails + 1))
  fi
done

# qid.dev/connect is a static GitHub Pages demo with a browser-simulated server,
# so the checker cannot drive it. Confirm the pieces a script can see.
code="$(curl -sL -o /dev/null -w '%{http_code}' https://qid.dev/connect/)"
[ "$code" = "200" ] && say "https://qid.dev/connect" "page 200 (demo: verify sign-in in a browser)" || {
  say "https://qid.dev/connect" "page $code"; fails=$((fails + 1)); }

echo
echo "Versions (these must all match)"
echo "------------------------------"
lab="$(python3 -c "import json;print(json.load(open('$HERE/../../../packages/server/package.json'))['version'])" 2>/dev/null)"
say "lab packages/server" "${lab:-?}"

widget="$(curl -s https://qid.dev/connect/widget.js | head -1 | grep -o 'v[0-9.]*' | head -1)"
say "live widget.js" "${widget:-?}"

tmp="$(mktemp -d)"
curl -sL https://qid.dev/connect/qid-connect-latest.zip -o "$tmp/p.zip"
pack="$(unzip -p "$tmp/p.zip" '*/packages/server/package.json' 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])" 2>/dev/null)"
say "live pack (latest.zip)" "${pack:-?}"
rm -rf "$tmp"

dash="$(grep -o '"[0-9]\+\.[0-9]\+\.[0-9]\+"' "$HERE/../../../../qid-dashboard/lib/probe.mjs" 2>/dev/null | head -1 | tr -d '"')"
say "dashboard WIDGET_LATEST" "${dash:-?}"

if [ -n "$lab" ] && [ "v$lab" = "$widget" ] && [ "$lab" = "$pack" ] && [ "$lab" = "$dash" ]; then
  echo
  echo "Versions agree at $lab"
else
  echo
  echo "VERSION MISMATCH - the release chain did not complete. See the four stages in PUBLISHING.md."
  fails=$((fails + 1))
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "All checkable surfaces healthy. Rendering still needs human eyes."
  exit 0
fi
echo "$fails surface(s) need attention."
exit 1
