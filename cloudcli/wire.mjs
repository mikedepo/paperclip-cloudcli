// AvgSoft's Paperclip + CloudCLI template: the wiring on the CloudCLI service, run as the node user at every start
// once CloudCLI answers. The login (email, then password) comes on stdin and is never printed or stored.
// 1. Clones REPO_URL into ~/<name> (once; the advanced route, /setup adds repos otherwise). For every connected repo,
//    points Claude Code's auto memory at its .claude/memory/ when there is one, and adds it to CloudCLI's projects.
// 2. The instruction layer, rewritten every time so template updates reach existing installs (layer.mjs).
// 3. Connects the skill and the /setup page to Paperclip: signs in with the login and creates a board API key named
//    "CloudCLI scheduled-jobs" (kept in ~/.config/scheduled-jobs/paperclip.json, mode 600), unless the stored one works.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  APP, CONFIG, H, SETUP, addProject, seedJobPermissions, bindRunnerSecrets, cloneRepo, log, readJson, repoInfo, repos, timezone, updateSetup,
  validZone, wireMemory, writeLayer, writePrivateJson,
} from './layer.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY_NAME = 'CloudCLI scheduled-jobs';
const paperclipUrl = (process.env.PAPERCLIP_URL || '').replace(/\/+$/, '');
const publicUrl = (process.env.PAPERCLIP_PUBLIC_URL || '').replace(/\/+$/, '');
const [email = '', password = ''] = fs.readFileSync(0, 'utf8').split('\n');
if (process.env.TZ && !validZone(process.env.TZ)) log(`TZ "${process.env.TZ}" is not a time zone name (use one like America/Toronto)`);

async function call(method, p, { token, cookie, body } = {}) {
  const headers = { accept: 'application/json', origin: publicUrl || paperclipUrl };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(paperclipUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, set: (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]) };
}

async function connect() {
  if (!paperclipUrl) { log('PAPERCLIP_URL is empty; the scheduled-jobs skill is not connected'); return; }
  const saved = readJson(CONFIG);
  const save = (data) => writePrivateJson(CONFIG, { ...readJson(CONFIG), ...data, url: paperclipUrl, publicUrl, timezone: timezone() });
  for (let i = 0; i < 60; i++) {
    try {
      if (saved.token && (await call('GET', '/api/companies', { token: saved.token })).ok) {
        save({});
        log('the scheduled-jobs skill is connected to Paperclip (stored key works)');
        return;
      }
      if (!email || !password) { log('no login to connect with; the scheduled-jobs skill is not connected'); return; }
      const si = await call('POST', '/api/auth/sign-in/email', { body: { email: email.trim().toLowerCase(), password } });
      if (si.status === 401) { log('signing in to Paperclip with the login failed (401); the scheduled-jobs skill is not connected. Redeploy after fixing the login.'); return; }
      if (!si.ok) throw new Error(`sign-in ${si.status}`);
      const cookie = si.set.join('; ');
      const key = await call('POST', '/api/board-api-keys', { cookie, body: { name: KEY_NAME, expiresAt: null } });
      if (!key.ok || !key.json?.token) throw new Error(`creating the key ${key.status}`);
      if (saved.keyId && saved.keyId !== key.json.id) await call('DELETE', `/api/board-api-keys/${saved.keyId}`, { cookie }).catch(() => {});
      await call('POST', '/api/auth/sign-out', { cookie, body: {} }).catch(() => {});
      save({ keyId: key.json.id, token: key.json.token });
      log(`the scheduled-jobs skill is connected to Paperclip (board API key "${KEY_NAME}")`);
      return;
    } catch (e) {
      if (i % 6 === 0) log(`waiting for Paperclip at ${paperclipUrl} (${e.cause?.code || e.message})`);
      await sleep(10000);
    }
  }
  log('Paperclip did not answer within 10 minutes; the scheduled-jobs skill is not connected. Restart CloudCLI to retry.');
}

// The setup state's one repo (before several were supported) becomes its list of repos.
if (readJson(SETUP).repo) { updateSetup({}); log('setup state: the repo is now the first of its list of repos'); }
const repo = repoInfo(process.env.REPO_URL);
if (repo?.error) log(`REPO_URL: ${repo.error}; no repo cloned. Fix it in Variables and redeploy, or add a repo on /setup.`);
else if (repo) {
  const r = cloneRepo(repo);
  if (!r.ok) log(`cloning ${repo.url} failed (${r.error}). A private repo needs GitHub connected. It is retried at the next start.`);
}
for (const r of repos()) {
  if (wireMemory(r)) log(`Claude's auto memory in ${r.dir} is its .claude/memory/`);
  addProject(r);
}
writeLayer();
log('instruction layer written: ~/.claude/CLAUDE.md block and the scheduled-jobs skill');
if (seedJobPermissions()) log("approved what creating a job needs in Claude Code's user settings (the jobs script, file edits, basic git and gh); everything else still asks");

// CloudCLI's own first-run wizard (git name and email, then agent sign-ins) repeats what this template already does:
// git's identity is set machine-wide from the login, and /setup connects Claude and GitHub. Mark it done.
try {
  const Database = createRequire(path.join(APP, 'package.json'))('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH || path.join(H, '.cloudcli', 'auth.db'));
  const { changes } = db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE has_completed_onboarding IS NOT 1').run();
  db.close();
  if (changes) log("CloudCLI's first-run wizard marked done (this template sets git's identity, and /setup connects the accounts)");
} catch (e) {
  log(`marking CloudCLI's first-run wizard done failed (${e.message}); it shows once`);
}

await connect();

// Installs from before the Runner's bindings covered GitHub get them here, with no step to redo.
try {
  const { bound } = await bindRunnerSecrets();
  if (bound.length) log(`bound ${bound.join(', ')} on Paperclip's Runner (from its company secrets)`);
} catch (e) {
  log(`checking the Runner's secrets failed (${e.message}); retried at the next start`);
}
