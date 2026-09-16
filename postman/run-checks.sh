#!/usr/bin/env bash
# Runs the same checks as the Postman collection in this directory, via curl.
# Usage: bash postman/run-checks.sh [baseUrl]
set -uo pipefail

BASE="${1:-http://localhost:4000/api/auth}"
PASS=0
FAIL=0
RAND=$((RANDOM * RANDOM))
EMAIL="postman-check-${RAND}@example.com"
PASSWORD="correcthorsebattery"
NEW_PASSWORD="correcthorsebattery2"

green() { printf '\033[32m%s\033[0m\n' "$1"; return 0; }
red()   { printf '\033[31m%s\033[0m\n' "$1" >&2; return 0; }

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    green "PASS  $label (got $actual)"
    PASS=$((PASS + 1))
  else
    red "FAIL  $label (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
  return 0
}

req() {
  # req METHOD PATH BODY [BEARER]
  local method="$1" path="$2" body="${3:-}" bearer="${4:-}"
  local args=(-sS -m 10 -o /tmp/postman_check_body.json -w '%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json')
  [[ -n "$body" ]] && args+=(-d "$body")
  [[ -n "$bearer" ]] && args+=(-H "Authorization: Bearer $bearer")
  curl "${args[@]}" 2>/tmp/postman_check_err.log
  return $?
}

echo "== Auth Service checks against $BASE =="
echo "Using throwaway account: $EMAIL"
echo

# --- 1. Happy path ---
code=$(req POST /signup "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Postman Check\"}")
check "Signup" 201 "$code"
BODY=$(cat "/tmp/postman_check_body.json")
ACCESS=$(node -pe "JSON.parse(process.argv[1]).tokens.accessToken" "$BODY" 2>/dev/null)
REFRESH=$(node -pe "JSON.parse(process.argv[1]).tokens.refreshToken" "$BODY" 2>/dev/null)

code=$(req GET /me "" "$ACCESS")
check "Get Me (authenticated)" 200 "$code"

code=$(req POST /login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
check "Login" 200 "$code"
BODY=$(cat "/tmp/postman_check_body.json")
ACCESS=$(node -pe "JSON.parse(process.argv[1]).tokens.accessToken" "$BODY" 2>/dev/null)
REFRESH=$(node -pe "JSON.parse(process.argv[1]).tokens.refreshToken" "$BODY" 2>/dev/null)

code=$(req POST /refresh "{\"refreshToken\":\"$REFRESH\"}")
check "Refresh (rotates token)" 200 "$code"
BODY=$(cat "/tmp/postman_check_body.json")
OLD_REFRESH="$REFRESH"
ACCESS=$(node -pe "JSON.parse(process.argv[1]).tokens.accessToken" "$BODY" 2>/dev/null)
REFRESH=$(node -pe "JSON.parse(process.argv[1]).tokens.refreshToken" "$BODY" 2>/dev/null)
if [[ "$REFRESH" != "$OLD_REFRESH" ]]; then
  green "PASS  Refresh token was rotated (old one is now burned)"
  PASS=$((PASS + 1))
else
  red "FAIL  Refresh token did not change"
  FAIL=$((FAIL + 1))
fi

code=$(req POST /logout "{\"refreshToken\":\"$REFRESH\"}")
check "Logout" 204 "$code"

code=$(req POST /refresh "{\"refreshToken\":\"$REFRESH\"}")
check "Refresh after logout (token burned)" 401 "$code"

echo
echo "== Validation & error cases =="

code=$(req POST /signup "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
check "Signup duplicate email" 409 "$code"

code=$(req POST /signup "{\"email\":\"short-pw-${RAND}@example.com\",\"password\":\"short\"}")
check "Signup password too short" 400 "$code"

code=$(req POST /login "{\"email\":\"$EMAIL\",\"password\":\"definitely-wrong\"}")
check "Login wrong password (generic 401)" 401 "$code"
MSG1=$(node -pe "JSON.parse(process.argv[1]).error.message" "$(cat "/tmp/postman_check_body.json")" 2>/dev/null)

code=$(req POST /login "{\"email\":\"nobody-${RAND}@example.com\",\"password\":\"whatever123\"}")
check "Login nonexistent email (generic 401)" 401 "$code"
MSG2=$(node -pe "JSON.parse(process.argv[1]).error.message" "$(cat "/tmp/postman_check_body.json")" 2>/dev/null)

if [[ "$MSG1" == "$MSG2" && -n "$MSG1" ]]; then
  green "PASS  Anti-enumeration: wrong-password and no-such-user return identical messages ('$MSG1')"
  PASS=$((PASS + 1))
else
  red "FAIL  Anti-enumeration: messages differ ('$MSG1' vs '$MSG2')"
  FAIL=$((FAIL + 1))
fi

code=$(req GET /me "")
check "Get Me with no token" 401 "$code"

code=$(req GET /me "" "not-a-real-token")
check "Get Me with garbage token" 401 "$code"

code=$(req POST /email/verify "{\"email\":\"$EMAIL\"}")
check "Request email verification (generic 200)" 200 "$code"

code=$(req POST /password/reset "{\"email\":\"$EMAIL\"}")
check "Request password reset (generic 200)" 200 "$code"

echo
echo "== $PASS passed, $FAIL failed =="
[[ "$FAIL" -eq 0 ]]
