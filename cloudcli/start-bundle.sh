#!/bin/bash
# AvgSoft's Paperclip + CloudCLI template: the CloudCLI service's start (the image's entrypoint, see the Dockerfile).
# CloudCLI's own start (start.sh, from our CloudCLI template, unchanged) installs the tools, applies the login and runs
# CloudCLI, here on an inner port. In front of it, front.mjs serves the /setup page and passes everything else to
# CloudCLI. Once CloudCLI answers, wire.mjs adds the instruction layer, the repo and the connection to Paperclip.
B=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
chmod -R a+rX "$B"
echo "[paperclip-cloudcli] CloudCLI service, code $(printf %.7s "${RAILWAY_GIT_COMMIT_SHA:-unknown}")"
echo "[paperclip-cloudcli] What changed: https://github.com/mikedepo/paperclip-cloudcli/blob/main/CHANGELOG.md"
for v in GH_TOKEN REPO_URL CLAUDE_CODE_OAUTH_TOKEN TZ; do
  [ -n "${!v}" ] || unset "$v"
done
# Commits work out of the box: the login email as git's identity, machine-wide (rewritten at every start).
# A ~/.gitconfig identity, set later by the user, wins.
if [ -n "$CLOUDCLI_USERNAME" ] && [ "${CLOUDCLI_USERNAME#*@}" != "$CLOUDCLI_USERNAME" ]; then
  git config --system user.email "$CLOUDCLI_USERNAME"
  git config --system user.name "${CLOUDCLI_USERNAME%%@*}"
fi

FRONT_PORT=${PORT:-3001}
INNER_PORT=3002
AS_NODE="setpriv --reuid=node --regid=node --init-groups env -u CLOUDCLI_USERNAME -u CLOUDCLI_PASSWORD HOME=/home/node PATH=/home/node/.local/bin:/home/node/.npm-global/bin:$PATH"

# The front process on the public port, restarted if it ever stops.
(
  while true; do
    $AS_NODE FRONT_PORT="$FRONT_PORT" UPSTREAM_PORT="$INNER_PORT" node "$B/front.mjs"
    sleep 2
  done
) &

# The web login is also the Paperclip login. start.sh takes it out of the environment, so the wiring gets it on stdin.
LOGIN=$(printf '%s\n%s' "$CLOUDCLI_USERNAME" "$CLOUDCLI_PASSWORD")
(
  for _ in $(seq 1 180); do
    curl -fs "http://127.0.0.1:$INNER_PORT/health" > /dev/null && break
    sleep 5
  done
  printf '%s' "$LOGIN" | $AS_NODE node "$B/wire.mjs" 2>&1 | tee -a /home/node/.local/state/railway-setup/setup.log
) &
unset LOGIN

export PORT=$INNER_PORT
exec bash "$B/start.sh"
