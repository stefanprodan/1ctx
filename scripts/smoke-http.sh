# shellcheck shell=bash
# Sourced by smoke.sh and image-smoke.sh: the HTTP checks of a running
# server at $URL, its files in $RUN, its admin key in $ADMIN_KEY. The
# caller defines fail().

# a body is read into a variable and grepped there: grep -q piped from
# curl stops at the first match, curl then dies of the broken pipe, and
# pipefail turns a good answer into a failure whenever curl loses the race
get() { curl -sf "$1" || fail "GET $1 did not answer"; }

# the key goes on stdin, never on curl's argument list, which ps shows
key_body() { printf '{"key":"%s"}' "$1"; }

smoke_http() {
  local health page script chunk login wrong cross
  health=$(get "$URL/api/health")
  grep -q '"ok":true' <<<"$health" || fail "health is not ok"
  page=$(get "$URL/")
  grep -q '<div id="app">' <<<"$page" || fail "the page did not render"
  script=$(grep -o 'src="[^"]*\.js"' <<<"$page" | head -1 | cut -d'"' -f2)
  [[ -n "$script" ]] || fail "the page has no script"
  chunk=$(get "$URL$script")
  grep -q 'preact\|render' <<<"$chunk" || fail "the script did not serve"

  login=$(key_body "$ADMIN_KEY" | curl -s -c "$RUN/cookies" -o /dev/null \
    -w '%{http_code} %{header_json}' \
    -H 'content-type: application/json' -H "origin: $URL" \
    --data-binary @- "$URL/api/login")
  [[ "$login" == 200* ]] || fail "login answered ${login%% *}"
  echo "$login" | grep -q 'login=' || fail "login set no cookie"

  curl -sf -b "$RUN/cookies" -D "$RUN/visual-headers" \
    -o "$RUN/visual.html" "$URL/api/visual" \
    || fail "visual shell did not answer"
  grep -q 'var Idiomorph=function' "$RUN/visual.html" \
    || fail "the compiled visual shell has no Idiomorph"
  grep -qi 'content-security-policy: sandbox allow-scripts' \
    "$RUN/visual-headers" || fail "the visual shell has no sandbox header"
  grep -qi 'connect-src.*none' "$RUN/visual-headers" \
    || fail "the visual shell allows connections"

  wrong=$(key_body "1ctx-admin-$(printf 'A%.0s' {1..43})" \
    | curl -s -o /dev/null -w '%{http_code}' \
      -H 'content-type: application/json' -H "origin: $URL" \
      --data-binary @- "$URL/api/login")
  [[ "$wrong" == 401 ]] || fail "a wrong admin key answered $wrong"

  cross=$(key_body "$ADMIN_KEY" | curl -s -o /dev/null -w '%{http_code}' \
    -H 'content-type: application/json' -H 'origin: http://evil.test' \
    --data-binary @- "$URL/api/login")
  [[ "$cross" == 403 ]] || fail "a cross-origin write answered $cross"
}
