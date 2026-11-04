#!/bin/sh
# AvgSoft's Paperclip + CloudCLI template: the Paperclip service's start (the image's entrypoint, see the Dockerfile).
# Runs as root only for two machine-wide settings in the container (rewritten at every start), then hands over to
# the image's own entrypoint, which drops to the node user and runs node-start.sh.
B=$(cd "$(dirname "$0")" && pwd)
chmod -R a+rX "$B"
echo "[paperclip-cloudcli] Paperclip service, code $(printf %.7s "${RAILWAY_GIT_COMMIT_SHA:-unknown}")"
echo "[paperclip-cloudcli] What changed: https://github.com/mikedepo/paperclip-cloudcli/blob/main/CHANGELOG.md"

# git uses a GitHub token from the environment for github.com, whatever HOME a run has (Paperclip's own AI sign-ins give
# each run its own HOME): GH_TOKEN from Variables, or GH_TOKEN bound on the Runner from the GITHUB_TOKEN company secret
# (CloudCLI binds it; Paperclip itself uses that secret only for its own checkouts).
git config --system credential.https://github.com.helper '!gh auth git-credential'

# Paperclip keeps every variable named *KEY*, *SECRET* or *TOKEN* out of the Codex agent's commands, so that agent
# also gets the GitHub token as GH_PAT (the owner's choice, 2026-11-04). This wrapper, ahead of the image's
# /usr/bin/gh on PATH, uses it when no GitHub token is set; git reaches GitHub through gh (above), so both work.
if [ -x /usr/bin/gh ]; then
  cat > /usr/local/bin/gh <<'EOF'
#!/bin/sh
if [ -z "$GH_TOKEN$GITHUB_TOKEN" ] && [ -n "$GH_PAT" ]; then export GH_TOKEN="$GH_PAT"; fi
exec /usr/bin/gh "$@"
EOF
  chmod 755 /usr/local/bin/gh
fi

# Commits work out of the box: the admin email as git's identity, machine-wide, so every run has it whatever its
# HOME. A ~/.gitconfig identity, set later by the user, wins.
if [ -n "$ADMIN_EMAIL" ]; then
  git config --system user.email "$ADMIN_EMAIL"
  git config --system user.name "${ADMIN_EMAIL%%@*}"
fi

# Claude Code's machine-wide settings file. memory-sync.mjs writes the shared-memory setting there while one repo is
# checked out: it is the only settings file runs with Paperclip's AI sign-in read besides their temporary user settings.
mkdir -p /etc/claude-code && chown node:node /etc/claude-code

exec docker-entrypoint.sh /bin/sh "$B/node-start.sh"
