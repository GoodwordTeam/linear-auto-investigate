#!/usr/bin/env bash
set -euo pipefail

# Manually trigger an investigation for a Linear ticket.
# This calls the GitHub Actions workflow_dispatch API.
#
# Usage: ./trigger-investigation.sh <ticket-id>
# Requires: GITHUB_TOKEN, GITHUB_REPO (e.g., "org/linear-auto-investigate")

TICKET_ID="${1:?Usage: ./trigger-investigation.sh <ticket-id>}"
GITHUB_REPO="${GITHUB_REPO:?Set GITHUB_REPO env var (e.g., org/linear-auto-investigate)}"
GITHUB_TOKEN="${GITHUB_TOKEN:?Set GITHUB_TOKEN env var}"

echo "Triggering investigation for ticket: $TICKET_ID"

curl -s -X POST \
  "https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/investigate.yml/dispatches" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  -d "{
    \"ref\": \"main\",
    \"inputs\": {
      \"ticket_id\": \"${TICKET_ID}\"
    }
  }"

echo "Investigation triggered! Check GitHub Actions for progress."
