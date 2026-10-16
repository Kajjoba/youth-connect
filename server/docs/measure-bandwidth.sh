#!/usr/bin/env bash
# Reproducible bandwidth evidence for the evaluation chapter.
# Usage:  API=http://localhost:4000/api ./docs/measure-bandwidth.sh
set -euo pipefail

API="${API:-http://localhost:4000/api}"
EMAIL="${EMAIL:-amina@ycp.africa}"
PASSWORD="${PASSWORD:-YcpDemo2026!}"

token=$(curl -s -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')

auth="Authorization: Bearer $token"
endpoint="$API/activities?limit=20"

full=$(curl -s -o /dev/null -w '%{size_download}' "$endpoint" -H "$auth")
gzip_size=$(curl -s -o /dev/null -w '%{size_download}' "$endpoint" -H "$auth" -H 'Accept-Encoding: gzip')
narrowed=$(curl -s -o /dev/null -w '%{size_download}' "$API/activities?limit=20&fields=id,title,payload_kb" -H "$auth")

printf '\nBandwidth measurement  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'Endpoint: %s\n\n' "$endpoint"
printf '  %-34s %8s bytes\n' 'First load, uncompressed'   "$full"
printf '  %-34s %8s bytes\n' 'First load, gzip'           "$gzip_size"
printf '  %-34s %8s bytes\n' 'Narrowed with ?fields='     "$narrowed"
python3 - "$full" "$gzip_size" "$narrowed" <<'PY'
import sys
full, gz, narrow = (int(v) for v in sys.argv[1:4])
print()
print(f'  gzip saving       {100*(1-gz/full):.1f}%')
print(f'  fields= saving    {100*(1-narrow/full):.1f}%')
print()
PY
