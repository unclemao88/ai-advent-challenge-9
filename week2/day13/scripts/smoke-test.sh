#!/bin/sh
# Check a running instance.
#
#   sh scripts/smoke-test.sh [base-url] [--chat]
#
# Without --chat nothing is sent to DeepSeek (no cost): health, configuration,
# page, profile, memory, tasks and a context preview are checked. With --chat
# one real question is asked (one DeepSeek call, manual mode).
# If the server requires a token, export APP_AUTH_TOKEN first.
set -u

BASE=http://127.0.0.1:3013
CHAT=no
for arg in "$@"; do
  case $arg in
    --chat) CHAT=yes ;;
    http*) BASE=${arg%/} ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

api() { # api METHOD PATH [JSON]
  if [ -n "${APP_AUTH_TOKEN:-}" ]; then
    set -- "$@" -H "Authorization: Bearer $APP_AUTH_TOKEN"
  fi
  method=$1; path=$2; shift 2
  if [ "$method" = POST ]; then
    body=$1; shift
    curl -fsS -X POST -H 'Content-Type: application/json' -d "$body" "$@" "$BASE$path"
  else
    curl -fsS "$@" "$BASE$path"
  fi
}

failures=0
expect() { # expect NAME PATTERN OUTPUT
  if printf '%s' "$3" | grep -q -- "$2"; then
    printf 'ok    %s\n' "$1"
  else
    printf 'FAIL  %s\n      %s\n' "$1" "$(printf '%s' "$3" | head -c 300)"
    failures=$((failures + 1))
  fi
}

expect "health"              '"status":"ok"'              "$(curl -fsS "$BASE/api/health" 2>&1)"
expect "page loads"          'ask your question, master'  "$(curl -fsS "$BASE/" 2>&1)"
config=$(api GET /api/config 2>&1)
expect "config"              '"apiKeyConfigured"'         "$config"
expect "api key configured"  '"apiKeyConfigured":true'    "$config"
expect "profile endpoint"    '"exists"'                   "$(api GET /api/profile 2>&1)"
expect "memory endpoint"     '"storage"'                  "$(api GET /api/memory 2>&1)"
expect "tasks endpoint"      '"tasks"'                    "$(api GET /api/tasks 2>&1)"
expect "context preview"     '"currentRequestContext"'    "$(api POST /api/context/preview '{"message":"smoke test"}' 2>&1)"

if [ "$CHAT" = yes ]; then
  expect "chat (1 DeepSeek call)" '"currentState":"planning"' \
    "$(api POST /api/chat '{"message":"Smoke test: reply with a one-line plan.","mode":"manual"}' 2>&1)"
fi

method=$(printf '%s' "$config" | sed -n 's/.*"tokenizer":{"method":"\([a-z]*\)".*/\1/p')
echo "token counting: ${method:-unknown}"
[ "$failures" -eq 0 ]
