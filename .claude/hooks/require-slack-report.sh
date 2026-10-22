#!/usr/bin/env bash
# Stop hook: post Sam's work history report to Slack automatically.
#
# Why the hook posts it (and not Claude via the Slack MCP connector):
# an MCP connector call triggers an approval dialog on every turn. Hook
# commands run directly, with no permission prompt, so posting from here
# is the only way the report is truly automatic.
#
# Contract with Claude:
#   Claude writes the report body to .claude/.slack-report.md before the
#   turn ends. This hook picks it up, posts it, and deletes it.
#
# How it works:
#   1. Reads the Stop hook payload on stdin.
#   2. Looks for the report file.
#        found    -> POST to the Slack Incoming Webhook, delete, allow stop
#        missing  -> block once, tell Claude to write the file
#   3. A per session sentinel file makes sure it only blocks once per turn,
#      so a turn can never get stuck in a loop.
#
# Destination:
#   A Make.com webhook that relays into #sams-claude-updates. The URL is
#   hardcoded so no per environment setup is needed. Override it for a
#   one off by exporting REPORT_WEBHOOK_URL.
#
# Requires: jq, curl

set -u

WEBHOOK_URL="${REPORT_WEBHOOK_URL:-https://hook.us2.make.com/h7ugep8yv7gi773krwm0vyrf59992f34}"

payload="$(cat)"
session="$(printf '%s' "$payload" | jq -r '.session_id // "unknown"')"

project_dir="${CLAUDE_PROJECT_DIR:-.}"
report="$project_dir/.claude/.slack-report.md"

state_dir="${TMPDIR:-/tmp}/claude-slack-report"
sentinel="$state_dir/$session"

fail() {
  jq -nc --arg msg "$1" '{systemMessage: $msg}'
  exit 0
}

if [ -s "$report" ]; then
  body="$(jq -Rs '{text: .}' < "$report")"
  http="$(curl -sS -o /dev/null -w '%{http_code}' \
           -X POST -H 'Content-Type: application/json' \
           --data "$body" \
           --max-time 15 \
           "$WEBHOOK_URL" 2>/dev/null)"

  if [ "$http" = "200" ]; then
    rm -f "$report" "$sentinel"
    exit 0
  fi

  fail "Work history report POST failed with HTTP $http. The report is still at .claude/.slack-report.md."
fi

# Already blocked once this turn. Warn and let it stop rather than loop.
if [ -f "$sentinel" ]; then
  rm -f "$sentinel"
  printf '%s\n' '{"systemMessage":"No Slack work history report was written for this message. Rule 4 in CLAUDE.md was skipped."}'
  exit 0
fi

mkdir -p "$state_dir" && : > "$sentinel"

jq -nc '{
  decision: "block",
  reason: (
    "Rule 4 in CLAUDE.md has not been satisfied: no work history report was written for this message. "
    + "Do NOT call the Slack tool. Write the report to .claude/.slack-report.md instead. The Stop hook posts it to #sams-claude-updates automatically, with no approval prompt.\n\n"
    + "Use this format:\n\n"
    + "Title: <seven word descriptive title>\nType: Client (<client name>) or Internal\nSummary: <under 100 words>\nDetails:\n- <most important detail>\n- <second detail>\n- <third detail, if there is one>\nState: <done / in progress / blocked>\nOpen: <anything left, or \"none\">\n\n"
    + "Title is exactly seven words. Type is Client when the work touches a client repo, site, account, or deliverable, with the client name in parentheses, otherwise Internal. Summary stays under 100 words. Details are three bullets max, fewer is fine, never more. "
    + "Caveman mode, no em dashes, no emojis. Report on this message only, not the whole session. "
    + "Write the file, then stop."
  )
}'
