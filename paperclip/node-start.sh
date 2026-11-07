#!/bin/sh
# Runs as the node user. First admin from the deploy form (admin-setup.mjs, from our Paperclip template, unchanged),
# then the wiring in the background (wire.mjs: repo, shared memory, company, project, the Runner agent), the shared-memory
# check (memory-sync.mjs, every minute, without the admin login in its environment), then Paperclip.
B=$(cd "$(dirname "$0")" && pwd)
cd /app || exit 1
for v in GH_TOKEN REPO_URL CLAUDE_CODE_OAUTH_TOKEN TZ; do
  eval "[ -n \"\$$v\" ]" || unset "$v"
done

node "$B/admin-setup.mjs"
# Subshells, so these are re-parented to tini (which reaps them) instead of to Paperclip's node process.
( node "$B/wire.mjs" & )
( env -u ADMIN_EMAIL -u ADMIN_PASSWORD node "$B/memory-sync.mjs" & )

# Agents inherit Paperclip's environment: they don't need the admin login.
unset ADMIN_EMAIL ADMIN_PASSWORD
# The image's own start (Paperclip 2026.1106 boots from a precompiled bundle; older images had only the tsx build).
if [ -f server/dist-runtime/index.mjs ]; then exec node server/dist-runtime/index.mjs; fi
exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
