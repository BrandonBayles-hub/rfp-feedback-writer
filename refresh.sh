#!/bin/bash
set -euo pipefail
GATE="rfp-feedback-9c3e1a7b"
REPO="entrata/product-prototypes"
FILE="implementation-prototype/fortiva-residential/feedback-api.json"

current="$(gh api "repos/$REPO/contents/$FILE" --jq .content | tr -d '\n' | base64 -d || true)"
left="$(CURRENT_JSON="$current" python3 - << 'PY'
import json, os, datetime
raw = os.environ.get("CURRENT_JSON", "")
try:
    data = json.loads(raw)
except Exception:
    print(0)
    raise SystemExit
exp = data.get("expires")
if not exp:
    print(0)
    raise SystemExit
when = datetime.datetime.fromisoformat(exp.replace("Z", "+00:00"))
print(int((when - datetime.datetime.now(datetime.timezone.utc)).total_seconds()))
PY
)"
if [ "${left:-0}" -gt 1800 ]; then
  echo "current writer has $left seconds left"
  exit 0
fi

cd worker
export CI=true WRANGLER_SEND_METRICS=false
out="$(npx --yes wrangler@4.156.2 deploy --temporary)"
url="$(printf '%s\n' "$out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
test -n "$url"
printf '%s' "$FEEDBACK_GITHUB_TOKEN" | npx --yes wrangler@4.156.2 secret put GITHUB_TOKEN --temporary >/dev/null
ok=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf --max-time 20 -A "Mozilla/5.0" -H "x-rfp-feedback: $GATE" "$url" | grep -q '^\['; then
    ok=1
    break
  fi
  sleep 3
done
test "$ok" = 1
toml="$(find "$HOME" -name 'wrangler-temporary-account.toml' | head -1)"
expires="$(python3 -c 'import pathlib,sys; text=pathlib.Path(sys.argv[1]).read_text();
print(next(line.split("=",1)[1].strip().strip(chr(34)) for line in text.splitlines() if line.strip().startswith("expiresAt")))' "$toml")"
test -n "$expires"
python3 -c 'import json,sys; print(json.dumps({"url":sys.argv[1],"expires":sys.argv[2]}, indent=2))' "$url" "$expires" > /tmp/feedback-api.json
sha="$(gh api "repos/$REPO/contents/$FILE" --jq .sha)"
gh api --method PUT "repos/$REPO/contents/$FILE" \
  -f message="chore: refresh RFP feedback writer" \
  -f content="$(base64 < /tmp/feedback-api.json | tr -d '\n')" \
  -f sha="$sha" >/dev/null
echo "writer refreshed until $expires"
