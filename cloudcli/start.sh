#!/bin/bash
# Start CloudCLI on Railway. Runs as root to prepare the volume at /home/node, installs CloudCLI,
# Claude Code, Codex and the GitHub CLI into the home folder on first start, applies the login from the
# deploy form, then runs CloudCLI as the image's node user. Everything installed lives on the volume.
# The template's start command is this file base64-encoded (build-start-command.mjs).

# CloudCLI is pinned; a newer one installed with CloudCLI's own Update button is kept.
CLOUDCLI_VERSION=1.37.7
GH_VERSION=2.103.3

H=/home/node
STATE=$H/.local/state/railway-setup
export HOME=$H USER=node LOGNAME=node SHELL=/bin/bash
export NPM_CONFIG_PREFIX=$H/.npm-global
export PATH="$H/.local/bin:$H/.npm-global/bin:$PATH"
APP=$NPM_CONFIG_PREFIX/lib/node_modules/@cloudcli-ai/cloudcli
export DATABASE_PATH=$H/.cloudcli/auth.db

AS_NODE="setpriv --reuid=node --regid=node --init-groups"
as_node() { $AS_NODE "$@"; }
# Railway can drop a container's first log lines, so the log also goes to a file in the home folder.
log() { echo "[setup] $*"; echo "$(date -u +%FT%TZ) $*" >> "$STATE/setup.log"; }

# A new Railway volume is owned by root and holds lost+found; the image's own home is hidden by it.
rmdir "$H/lost+found" 2>/dev/null
chown node:node "$H"
cd "$H" || exit 1
as_node mkdir -p "$H/.local/bin" "$H/.npm-global" "$H/.cloudcli" "$STATE"
for f in .bashrc .profile .bash_logout; do
  [ -e "$H/$f" ] || as_node cp "/etc/skel/$f" "$H/$f"
done
# Login shells reset PATH from /etc/profile; keep the home folder's tools first there too.
grep -q 'railway-setup' "$H/.profile" ||
  echo 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH" NPM_CONFIG_PREFIX="$HOME/.npm-global" # railway-setup' >> "$H/.profile"

# The tools take about 2.5 GB, more than the 0.5 GB volume of Free and Trial plans. Rather than fail the
# deploy, answer every request (and the health check) with the reason and the fix.
VOLUME_MB=$(df -Pm "$H" | awk 'NR == 2 { print $2 }')
if [ "${VOLUME_MB:-0}" -lt 3000 ]; then
  export MESSAGE="CloudCLI with Claude Code and Codex needs about 2.5 GB of disk, and this volume holds $VOLUME_MB MB (Free and Trial plans get 0.5 GB). Deploy it on a Hobby or Pro plan."
  log "$MESSAGE"
  exec node -e "require('http').createServer((q, s) => s.end(process.env.MESSAGE + '\n')).listen(process.env.PORT || 3001)"
fi

app_version() { node -p "require('$APP/package.json').version" 2>/dev/null; }
INSTALLED=$(app_version)
NPM_PACKAGES=
if [ -z "$INSTALLED" ] || [ ! -e "$NPM_CONFIG_PREFIX/bin/cloudcli" ] || { [ "$INSTALLED" != "$CLOUDCLI_VERSION" ] &&
  [ "$(printf '%s\n%s\n' "$INSTALLED" "$CLOUDCLI_VERSION" | sort -V | head -n1)" = "$INSTALLED" ]; }; then
  NPM_PACKAGES=" @cloudcli-ai/cloudcli@$CLOUDCLI_VERSION"
fi
# Codex and Claude Code update themselves into the same places (npm prefix, ~/.local) later.
[ -e "$NPM_CONFIG_PREFIX/bin/codex" ] || NPM_PACKAGES="$NPM_PACKAGES @openai/codex"

# Downloads run in parallel. A failed one never blocks CloudCLI: the next start tries again.
if [ ! -e "$H/.local/bin/claude" ]; then
  NEW=1
  ( log "installing Claude Code (native installer)"
    as_node bash -c 'set -o pipefail; curl -fsSL --retry 2 https://claude.ai/install.sh | bash' \
      > "$STATE/claude-install.log" 2>&1 && [ -e "$H/.local/bin/claude" ] &&
      log "Claude Code $(as_node "$H/.local/bin/claude" --version 2>/dev/null) ready" ||
      log "Claude Code install failed (see $STATE/claude-install.log); it will be retried at the next start" ) &
fi
if [ ! -e "$H/.local/bin/gh" ]; then
  NEW=1
  ( ARCH=$(dpkg --print-architecture)
    log "installing GitHub CLI $GH_VERSION"
    as_node bash -c "set -o pipefail; rm -rf $H/.local/share/gh && mkdir -p $H/.local/share/gh &&
      curl -fsSL --retry 2 --max-time 180 \
        https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_linux_$ARCH.tar.gz |
      tar -xz -C $H/.local/share/gh --strip-components=1 &&
      ln -sf $H/.local/share/gh/bin/gh $H/.local/bin/gh" &&
      log "$(as_node gh --version | head -n1) ready" ||
      log "GitHub CLI install failed; it will be retried at the next start" ) &
fi
if [ -n "$NPM_PACKAGES" ]; then
  NEW=1
  log "installing$NPM_PACKAGES with npm"
  as_node npm install -g --cache /tmp/npm-cache --no-audit --no-fund --no-update-notifier --loglevel=error $NPM_PACKAGES &&
    log "installed$NPM_PACKAGES" || log "npm install failed for$NPM_PACKAGES"
  rm -rf /tmp/npm-cache
fi
wait

if [ -z "$(app_version)" ]; then
  log "CloudCLI is not installed and could not be installed; retrying in 30 seconds"
  sleep 30
  exit 1
fi

# The login comes from the deploy form. CloudCLI's own first-run page lets whoever opens the URL first
# create the account, so the account exists before the public port opens, and its username and password
# follow CLOUDCLI_USERNAME and CLOUDCLI_PASSWORD at every start (change them in Variables to reset them).
sync_login() {
  as_node env CLOUDCLI_USERNAME="$CLOUDCLI_USERNAME" CLOUDCLI_PASSWORD="$CLOUDCLI_PASSWORD" APP="$APP" node - <<'EOF'
const { createRequire } = require('module');
const crypto = require('crypto');
const req = createRequire(process.env.APP + '/package.json');
const Database = req('better-sqlite3');
const bcrypt = req('bcrypt');
const db = new Database(process.env.DATABASE_PATH);
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) process.exit(3);
let username = process.env.CLOUDCLI_USERNAME || '';
let password = process.env.CLOUDCLI_PASSWORD || '';
const user = db.prepare('SELECT id, username, password_hash FROM users ORDER BY id LIMIT 1').get();
const say = (m) => console.log('[setup] ' + m);
if (!username || !password) {
  if (user) { say('CLOUDCLI_USERNAME or CLOUDCLI_PASSWORD is empty; keeping the existing login'); process.exit(0); }
  // Never leave the first-run page open to whoever comes first: lock the app until the variables are set.
  username = 'admin';
  password = crypto.randomBytes(24).toString('base64url');
  say('CLOUDCLI_USERNAME or CLOUDCLI_PASSWORD is empty: the app is locked. Set both in Variables and redeploy.');
}
if (password.length < 8) say('Warning: the password is shorter than 8 characters. Set a longer CLOUDCLI_PASSWORD in Variables.');
if (!user) {
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, bcrypt.hashSync(password, 12));
  say(`Login "${username}" created`);
} else if (user.username !== username || !bcrypt.compareSync(password, user.password_hash)) {
  db.prepare('UPDATE users SET username = ?, password_hash = ? WHERE id = ?').run(username, bcrypt.hashSync(password, 12), user.id);
  db.prepare("DELETE FROM app_config WHERE key = 'jwt_secret'").run();
  say(`Login changed to "${username}" from the deploy variables; every browser was signed out`);
} else {
  say(`Login "${username}" unchanged`);
}
EOF
}

sync_login
if [ $? -eq 3 ]; then
  # First start: let CloudCLI create its database on a loopback-only port, then add the login.
  log "creating CloudCLI's database on a private port"
  $AS_NODE env SERVER_PORT=39871 HOST=127.0.0.1 cloudcli start > "$STATE/first-start.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do
    curl -fs http://127.0.0.1:39871/health > /dev/null && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  if ! sync_login; then
    log "could not create the login (see $STATE/first-start.log); retrying in 30 seconds"
    sleep 30
    exit 1
  fi
fi
# The web login stays out of the environment that terminals and agents inherit.
unset CLOUDCLI_USERNAME CLOUDCLI_PASSWORD

# git and gh use the optional GitHub token from the deploy form.
if [ -n "$GH_TOKEN" ] && [ -e "$H/.local/bin/gh" ]; then
  as_node gh auth setup-git > /dev/null 2>&1 && log "git uses GH_TOKEN for github.com"
fi

# Unpacking leaves several hundred MB of page cache, which Railway's metrics count as memory until the
# container restarts. Drop the new files from the cache in the background once CloudCLI has started (dropped
# earlier, its own start reads them back); they are read back when used.
if [ -n "${NEW:-}" ]; then
  ( sleep 60
  python3 -I - "$NPM_CONFIG_PREFIX" "$H/.local/share" <<'EOF'
import os, sys
for top in sys.argv[1:]:
    for folder, _, files in os.walk(top):
        for name in files:
            try:
                fd = os.open(os.path.join(folder, name), os.O_RDONLY | os.O_NOFOLLOW)
            except OSError:
                continue
            try:
                os.fsync(fd)
                os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
            except OSError:
                pass
            os.close(fd)
EOF
  ) &
fi

export SERVER_PORT="${PORT:-3001}" HOST=0.0.0.0
log "starting CloudCLI $(app_version) on port $SERVER_PORT"
$AS_NODE cloudcli start &
child=$!
# bash stays as PID 1 so processes left behind by terminals are reaped, and passes Railway's stop on.
trap 'kill -TERM "$child" 2>/dev/null' TERM INT
status=0
while kill -0 "$child" 2>/dev/null; do
  wait "$child"
  status=$?
done
exit "$status"
