#!/bin/sh
# Runs as the node user. The hostnames Paperclip answers (below), the first admin from the deploy form (admin-setup.mjs,
# from our Paperclip template, unchanged), then the wiring in the background (wire.mjs: repo, shared memory, company,
# project, the Runner agent), the shared-memory check (memory-sync.mjs, every minute, without the admin login in its
# environment), then Paperclip.
B=$(cd "$(dirname "$0")" && pwd)
cd /app || exit 1
for v in GH_TOKEN REPO_URL CLAUDE_CODE_OAUTH_TOKEN TZ; do
  eval "[ -n \"\$$v\" ]" || unset "$v"
done

# Paperclip answers only its public URL's host and PAPERCLIP_ALLOWED_HOSTNAMES (403 for any other). Always added:
# Railway's health check, the private address (CloudCLI's), and every public domain this service has had, kept in
# a file on the volume. So an edit of the variable can't fail every deploy's health check, and the Railway address
# keeps working once a custom domain becomes the public one. Delete the file to forget old domains.
HOSTS=/paperclip/.bundle/public-hostnames
mkdir -p "$(dirname "$HOSTS")"
public_host=$(printf '%s' "$PAPERCLIP_PUBLIC_URL" | sed -E 's#^[A-Za-z]+://##; s#[/:?].*$##' | tr 'A-Z' 'a-z')
# Railway names a custom domain as the public one as soon as it is added, and no variable keeps its own address
# then. The address of the last start is also in the jobs config this service's wiring writes (wire.mjs), so an
# install whose first start with this code already has the custom domain still keeps its Railway address.
last_host=$(sed -n 's#^ *"publicUrl": *"[A-Za-z]*://\([^/:"]*\).*#\1#p' /paperclip/.bundle/scheduled-jobs.json 2>/dev/null | head -n 1)
for h in "$last_host" "$RAILWAY_PUBLIC_DOMAIN" "$public_host"; do
  h=$(printf '%s' "$h" | tr 'A-Z' 'a-z' | tr -d ' \r')
  if [ -n "$h" ] && ! grep -qxF "$h" "$HOSTS" 2>/dev/null; then printf '%s\n' "$h" >> "$HOSTS"; fi
done
PAPERCLIP_ALLOWED_HOSTNAMES=$({
  printf '%s\n' "$PAPERCLIP_ALLOWED_HOSTNAMES" | tr ',' '\n'
  printf '%s\n' healthcheck.railway.app "$RAILWAY_PRIVATE_DOMAIN" "$RAILWAY_PUBLIC_DOMAIN"
  cat "$HOSTS" 2>/dev/null
} | tr -d ' \t\r' | tr 'A-Z' 'a-z' | awk 'NF && !seen[$0]++' | tr '\n' ',' | sed 's/,$//')
export PAPERCLIP_ALLOWED_HOSTNAMES
echo "[paperclip-cloudcli] Paperclip answers ${public_host:-its public URL} and: $PAPERCLIP_ALLOWED_HOSTNAMES"

node "$B/admin-setup.mjs"
# Subshells, so these are re-parented to tini (which reaps them) instead of to Paperclip's node process.
( node "$B/wire.mjs" & )
( env -u ADMIN_EMAIL -u ADMIN_PASSWORD node "$B/memory-sync.mjs" & )

# Agents inherit Paperclip's environment: they don't need the admin login.
unset ADMIN_EMAIL ADMIN_PASSWORD
# The image's own start (Paperclip 2026.1106 boots from a precompiled bundle; older images had only the tsx build).
if [ -f server/dist-runtime/index.mjs ]; then exec node server/dist-runtime/index.mjs; fi
exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
