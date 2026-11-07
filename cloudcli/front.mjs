// AvgSoft's Paperclip + CloudCLI template: the front process on CloudCLI's public port, as the node user.
// - Everything except /setup goes to CloudCLI unchanged (HTTP and WebSocket), which listens on an inner port.
// - /setup: the one-time setup page, behind CloudCLI's own login (the page reuses CloudCLI's sign-in token; the
//   password is only passed through to CloudCLI's login API, never stored). Steps, each one can be redone:
//   1. Claude: runs the official `claude setup-token` in a terminal and relays what it prints (the sign-in link) and
//      the code the user pastes back; the token it prints goes to Claude Code's user settings here and to Paperclip
//      (company secret CLAUDE_CODE_OAUTH_TOKEN, referenced by the Runner agent), with no redeploy.
//   2. GitHub: `gh auth login --web` (device code), then `gh auth setup-git`; the token becomes Paperclip's GITHUB_TOKEN.
//   3. Repos: adds a repo (never replaces one): clones it into the home folder and gives it its own project in
//      Paperclip, whose primary workspace it is, so each repo's jobs run on that repo.
//   4. Time zone: from the browser; used by the scheduled-jobs script and terminals here.
//   Optional, Codex: Paperclip's own ChatGPT sign-in (device code) for a "Codex" agent that runs the jobs given to it,
//      and, separately, `codex login --device-auth` for Codex in CloudCLI.
// - Until setup is done or skipped, opening CloudCLI's home page redirects to /setup.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import {
  APP, CONFIG, H, addProject, bindRunnerSecrets, claudeSignedIn, cloneRepo, cloudcliUrl, codexIntent, codexSignedIn,
  connectCodexAgent, mcpCommand, mcpSetupUrl, mcpUrl, paperclipPublicUrl, pc, readJson, readSetup, repoInfo, repoProject, runnerContext, sameRepo,
  saveClaudeToken, timezone, updateSetup, upsertSecret, validZone, wireMemory, writeLayer, writePrivateJson, writeShellZone,
} from './layer.mjs';

const PORT = Number(process.env.FRONT_PORT || 3001);
const UP = Number(process.env.UPSTREAM_PORT || 3002);
const say = (m) => console.log(`[setup-page] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childEnv = (extra = {}) => {
  const env = { ...process.env, HOME: H, ...extra };
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'FRONT_PORT', 'UPSTREAM_PORT']) delete env[k];
  return env;
};

// ---------- step 1: Claude, through the official `claude setup-token` ----------

let claude = null; // { status, url, error, pty, out, mark }
const strip = (s) => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');
// Only a token followed by another character, so a token split across two reads is never taken half-printed.
const TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/;

function claudeStart() {
  if (claude && ['starting', 'waiting-code', 'checking'].includes(claude.status)) return;
  const pty = createRequire(path.join(APP, 'package.json'))('node-pty');
  const bin = fs.existsSync(path.join(H, '.local', 'bin', 'claude')) ? path.join(H, '.local', 'bin', 'claude') : 'claude';
  const env = childEnv();
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const job = { status: 'starting', url: null, error: null, out: '' };
  // A very wide terminal so the link and the token are printed on one line each.
  job.pty = pty.spawn(bin, ['setup-token'], { name: 'xterm-256color', cols: 4000, rows: 60, cwd: H, env });
  job.pty.onData((d) => {
    job.out = (job.out + d).slice(-200000);
    const text = strip(job.out);
    if (!job.url) {
      const m = text.match(/https:\/\/[^\s"'<>]*\/oauth\/authorize\?[^\s"'<>]+/);
      if (m) { job.url = m[0]; job.status = 'waiting-code'; }
    }
    const token = text.match(TOKEN);
    if (token && !['saving', 'done'].includes(job.status)) { job.status = 'saving'; claudeSave(job, token[0]); return; }
    // A rejected code: the code is single-use and tied to this link, so the user needs a new link.
    const rejected = job.status === 'checking' && strip(job.out.slice(job.mark)).match(/OAuth error[^\n]*?(?=Press Enter|\r|\n)/);
    if (rejected) {
      job.status = 'error';
      job.error = `Claude didn't accept that code (${rejected[0].trim()}). Press Start for a new link, then paste the code it shows.`;
      try { job.pty.kill(); } catch {}
    }
  });
  job.pty.onExit(({ exitCode }) => {
    const token = strip(job.out).match(/sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/);
    if (token && !['saving', 'done'].includes(job.status)) { job.status = 'saving'; claudeSave(job, token[0]); return; }
    if (['starting', 'waiting-code', 'checking'].includes(job.status)) {
      job.status = 'error';
      job.error = `claude setup-token ended (exit ${exitCode}) without a token: ${strip(job.out).trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300)}`;
    }
    job.out = '';
  });
  setTimeout(() => {
    if (job.status === 'starting') { job.status = 'error'; job.error = 'claude setup-token printed no sign-in link within 60 seconds'; try { job.pty.kill(); } catch {} }
  }, 60000);
  claude = job;
}

function claudeCode(code) {
  if (!claude || claude.status !== 'waiting-code') throw new Error('start the Claude step first');
  claude.status = 'checking';
  claude.error = null;
  claude.mark = claude.out.length;
  // Claude Code takes a fast multi-character write as a paste, and an Enter inside it as pasted text, not a submit.
  const job = claude;
  job.pty.write(String(code).trim());
  setTimeout(() => { try { job.pty.write('\r'); } catch {} }, 500);
  setTimeout(() => {
    if (claude?.status === 'checking') { claude.status = 'waiting-code'; claude.error = 'no token yet: check the code and paste it again'; }
  }, 90000);
}

async function claudeSave(job, token) {
  try { job.pty.kill(); } catch {}
  job.out = '';
  try {
    saveClaudeToken(token);
    const { company } = await runnerContext();
    await upsertSecret(company, 'CLAUDE_CODE_OAUTH_TOKEN', token);
    const { runner } = await bindRunnerSecrets();
    await pc('POST', `/api/agents/${runner.id}/lifecycle/retry`, {}).catch(() => {});
    updateSetup({ claude: { done: true, at: new Date().toISOString() }, done: true });
    writeLayer();
    job.status = 'done';
    say('Claude connected for CloudCLI and for Paperclip\'s Runner');
  } catch (e) {
    job.status = 'error';
    job.error = `the token was saved for CloudCLI, but Paperclip couldn't take it: ${e.message}. Redo this step to retry.`;
    updateSetup({ claude: { done: false, cloudcli: true } });
    say(job.error);
  }
}

// ---------- step 2: GitHub, through `gh auth login --web` ----------

let github = null; // { status, code, url, error }
const gh = (args, extra) => spawnSync('gh', args, { encoding: 'utf8', timeout: 60000, env: childEnv(extra) });

function githubStart() {
  if (github && ['starting', 'waiting-user'].includes(github.status)) return;
  const job = { status: 'starting', code: null, url: 'https://github.com/login/device', error: null, out: '' };
  const p = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'workflow'], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const onData = (d) => {
    job.out = (job.out + d).slice(-20000);
    const m = job.out.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/);
    if (m && !job.code) { job.code = m[1]; job.status = 'waiting-user'; }
    const u = job.out.match(/https:\/\/github\.com\/login\/device\S*/);
    if (u) job.url = u[0];
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.stdin.end('\n');
  p.on('exit', async (code) => {
    if (code !== 0) { job.status = 'error'; job.error = `gh auth login ended (exit ${code}): ${job.out.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`; return; }
    try {
      gh(['auth', 'setup-git']);
      const token = gh(['auth', 'token']).stdout.trim();
      const user = gh(['api', 'user', '-q', '.login']).stdout.trim();
      const { company } = await runnerContext();
      await upsertSecret(company, 'GITHUB_TOKEN', token);
      await bindRunnerSecrets();
      updateSetup({ github: { done: true, user } });
      job.status = 'done';
      say(`GitHub connected as ${user}`);
    } catch (e) {
      job.status = 'error';
      job.error = `GitHub is signed in here, but Paperclip couldn't take the token: ${e.message}. Redo this step to retry.`;
      updateSetup({ github: { done: false, user: null, cloudcli: true } });
    }
  });
  github = job;
}

function githubRepos() {
  const r = spawnSync('gh', ['api', '--paginate', 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', '-q', '.[] | [.full_name, (.private|tostring), (.description // "")] | @tsv'],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: H } });
  if (r.status !== 0) {
    const why = (r.stderr || '').trim().split('\n').pop() || 'gh failed';
    throw new Error(`can't list your repos (${why.slice(0, 160)}). Connect GitHub first, or type a public repo's address.`);
  }
  return r.stdout.trim().split('\n').filter(Boolean).slice(0, 300).map((l) => {
    const [name, priv, description] = l.split('\t');
    return { name, private: priv === 'true', description };
  });
}

// ---------- step 3: repos, one Paperclip project each ----------

async function pickRepo(raw) {
  const repo = repoInfo(raw);
  if (!repo) throw new Error('name a repo');
  if (repo.error) throw new Error(repo.error);
  const known = readSetup().repos;
  const prior = known.find((r) => sameRepo(r.url, repo.url));
  if (prior) Object.assign(repo, repoInfo(prior.url)); // a repo added again keeps the address it was first added with
  const c = cloneRepo(repo); // sets repo.dir: ~/<name>, or ~/<owner>-<name> when ~/<name> holds another repo
  if (!c.ok) throw new Error(`cloning failed: ${c.error}${/github\.com/.test(repo.url) ? ' (a private repo needs GitHub connected)' : ''}`);
  const memory = wireMemory(repo);
  addProject(repo);
  const entry = { url: repo.url, name: repo.name, dir: repo.dir };
  updateSetup({ repos: prior ? known.map((r) => (r === prior ? entry : r)) : [...known, entry] });
  let paperclip;
  try {
    const { project, how } = await repoProject(repo);
    const where = how === 'created' ? `a new Paperclip project "${project.name}"` : `Paperclip's project "${project.name}"`;
    paperclip = `Its jobs go in ${where}${how === 'reused' ? '' : '; Paperclip checks it out for the Runner at its first job'}`;
  } catch (e) {
    paperclip = `Paperclip not updated (${e.message}); press "Use this repo" again to retry`;
  }
  writeLayer();
  return { dir: repo.dir, cloned: !!c.cloned, memory, paperclip };
}

// Each connected repo for the page: its name, or owner/name when two share a name.
function repoList() {
  const list = readSetup().repos;
  return list.map((r) => {
    const info = repoInfo(r.url) || {};
    const twin = list.some((o) => o !== r && o.name === r.name);
    return { name: r.name, url: r.url, dir: r.dir, label: twin && info.owner ? `${info.owner}/${r.name}` : r.name };
  });
}

// ---------- optional: Codex, for Paperclip's jobs (Paperclip's own ChatGPT sign-in) and for CloudCLI ----------

const DEVICE_HINT = 'If ChatGPT said device code sign-in is off: in ChatGPT, Settings, Security and login, turn on "Enable device code sign-in for Codex" (near the bottom), then press Start again.';
let codex = null; // Paperclip's sign-in: { status, url, code, error }

// Paperclip runs `codex login --device-auth` on its own server and keeps the credential (encrypted, refreshed) as its
// AI connection; this only relays the link and one-time code it reports, then gives the "Codex" agent the connection.
function codexStart() {
  if (codex && ['starting', 'waiting-user', 'saving'].includes(codex.status)) return;
  const job = { status: 'starting', url: null, code: null, error: null };
  codex = job;
  codexSignIn(job).catch((e) => {
    job.status = 'error';
    job.error = `Codex isn't connected: ${e.message}`;
    say(job.error);
  });
}

async function codexSignIn(job) {
  const { company } = await runnerContext();
  const intent = await codexIntent(company);
  const base = `/api/companies/${company.id}/ai-connections/local`;
  const { sessionId } = await pc('POST', `${base}/attempts`, { ...intent, restart: true });
  const until = Date.now() + 10 * 60e3;
  for (;;) {
    const s = await pc('POST', `${base}/check`, { ...intent, localSessionId: sessionId });
    if (s?.status === 'ready') break;
    if (s?.status === 'expired') throw new Error('the sign-in expired. Press Start again.');
    if (s?.error) throw new Error(`${s.error} ${DEVICE_HINT}`);
    if (s?.authorizationUrl) job.url = s.authorizationUrl;
    if (s?.code) job.code = s.code;
    if (job.url && job.code) job.status = 'waiting-user';
    if (Date.now() > until) {
      await pc('DELETE', `${base}/attempts/${sessionId}`).catch(() => {});
      throw new Error('ChatGPT confirmed nothing within 10 minutes. Press Start again.');
    }
    await sleep(2000);
  }
  job.status = 'saving';
  const saved = await pc('POST', base, { ...intent, localSessionId: sessionId });
  const { how } = await connectCodexAgent(saved);
  updateSetup({ codex: { done: true, at: new Date().toISOString() } });
  writeLayer();
  job.status = 'done';
  say(`Codex connected for Paperclip's jobs (agent "Codex" ${how})`);
}

// Codex in CloudCLI's chats and terminal: its own sign-in, here (a second one-time code). The same credential can't
// serve both: Codex's refresh tokens are single-use, so two copies would sign each other out.
let codexHere = null; // { status, url, code, error, pty, out }
function codexHereStart() {
  if (codexHere && ['starting', 'waiting-user'].includes(codexHere.status)) return;
  const pty = createRequire(path.join(APP, 'package.json'))('node-pty');
  const own = path.join(H, '.npm-global', 'bin', 'codex');
  const env = childEnv({ BROWSER: 'true' });
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[k];
  const job = { status: 'starting', url: null, code: null, error: null, out: '' };
  job.pty = pty.spawn(fs.existsSync(own) ? own : 'codex', ['login', '--device-auth'], { name: 'xterm-256color', cols: 400, rows: 50, cwd: H, env });
  job.pty.onData((d) => {
    job.out = (job.out + d).slice(-50000);
    if (job.code) return;
    const text = strip(job.out);
    const url = text.match(/https:\/\/auth\.openai\.com\/[^\s"'<>]*/);
    const at = text.search(/one-time code/i); // the code is printed after this line
    const code = at >= 0 && text.slice(at).match(/\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/);
    if (url) job.url = url[0];
    if (code) { job.code = code[1]; job.status = 'waiting-user'; }
  });
  job.pty.onExit(({ exitCode }) => {
    if (exitCode === 0 && codexSignedIn()) {
      job.status = 'done';
      updateSetup({ codexCloudcli: { done: true, at: new Date().toISOString() } });
      say('Codex signed in for CloudCLI');
    } else if (!['done', 'error'].includes(job.status)) {
      job.status = 'error';
      job.error = `codex login ended (exit ${exitCode}) without signing in: ${strip(job.out).trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}. ${DEVICE_HINT}`;
    }
    job.out = '';
  });
  setTimeout(() => {
    if (job.status === 'starting') { job.status = 'error'; job.error = 'codex login printed no code within 60 seconds'; try { job.pty.kill(); } catch {} }
  }, 60000);
  setTimeout(() => {
    if (job.status === 'waiting-user') { job.status = 'error'; job.error = 'ChatGPT confirmed nothing within 15 minutes. Press the button again.'; try { job.pty.kill(); } catch {} }
  }, 15 * 60e3);
  codexHere = job;
}

// ---------- step 4: time zone ----------

function saveZone(zone) {
  if (!validZone(zone)) throw new Error(`"${zone}" is not a time zone name`);
  updateSetup({ timezone: zone });
  writeShellZone(zone);
  if (fs.existsSync(CONFIG)) writePrivateJson(CONFIG, { ...readJson(CONFIG), timezone: zone });
  writeLayer();
}

// ---------- HTTP ----------

const tokenCache = new Map();
async function authorized(req) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return false;
  const hit = tokenCache.get(m[1]);
  if (hit && hit > Date.now()) return true;
  try {
    const r = await fetch(`http://127.0.0.1:${UP}/api/auth/user`, { headers: { authorization: req.headers.authorization } });
    if (!r.ok) return false;
    tokenCache.set(m[1], Date.now() + 60000);
    return true;
  } catch { return false; }
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 65536) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad JSON')); } });
  });
}
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };

function state() {
  const s = readSetup();
  const cfg = readJson(CONFIG);
  return {
    claude: { done: !!s.claude?.done, cloudcliSignedIn: claudeSignedIn(), status: claude?.status || null, url: claude?.status === 'waiting-code' || claude?.status === 'checking' ? claude.url : null, error: claude?.error || null },
    github: { done: !!s.github?.done, user: s.github?.user || null, status: github?.status || null, code: github?.status === 'waiting-user' ? github.code : null, url: github?.url || null, error: github?.error || null },
    repos: repoList(),
    timezone: { value: timezone(), chosen: !!s.timezone },
    codex: {
      done: !!s.codex?.done, status: codex?.status || null, error: codex?.error || null,
      url: codex?.status === 'waiting-user' ? codex.url : null, code: codex?.status === 'waiting-user' ? codex.code : null,
      here: {
        done: codexSignedIn(), status: codexHere?.status || null, error: codexHere?.error || null,
        url: codexHere?.status === 'waiting-user' ? codexHere.url : null, code: codexHere?.status === 'waiting-user' ? codexHere.code : null,
      },
    },
    paperclipConnected: !!cfg.token,
    links: { cloudcli: cloudcliUrl || '/', paperclip: paperclipPublicUrl, mcp: mcpUrl, mcpSetup: mcpSetupUrl, mcpCommand: mcpUrl ? mcpCommand : '' },
    done: !!s.done,
    skipped: !!s.skipped,
  };
}

async function api(req, res, route) {
  if (route === 'login' && req.method === 'POST') {
    const b = await body(req);
    const r = await fetch(`http://127.0.0.1:${UP}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: b.username, password: b.password }) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.token ? send(res, 200, { token: j.token }) : send(res, 401, { error: 'wrong email or password' });
  }
  if (!(await authorized(req))) return send(res, 401, { error: 'sign in first' });
  if (route === 'state') return send(res, 200, state());
  const b = req.method === 'POST' ? await body(req) : {};
  try {
    if (route === 'claude/start') { claudeStart(); for (let i = 0; i < 40 && claude.status === 'starting'; i++) await sleep(500); return send(res, 200, state()); }
    if (route === 'claude/code') { claudeCode(b.code || ''); for (let i = 0; i < 60 && claude.status === 'checking'; i++) await sleep(1000); return send(res, 200, state()); }
    if (route === 'github/start') { githubStart(); for (let i = 0; i < 30 && github.status === 'starting'; i++) await sleep(500); return send(res, 200, state()); }
    if (route === 'github/repos') return send(res, 200, { repos: githubRepos() });
    if (route === 'repo') return send(res, 200, { ...(await pickRepo(b.repo)), state: state() });
    if (route === 'timezone') { saveZone(b.timezone); return send(res, 200, state()); }
    if (route === 'codex/start') { codexStart(); for (let i = 0; i < 40 && codex.status === 'starting'; i++) await sleep(500); return send(res, 200, state()); }
    if (route === 'codex/here') { codexHereStart(); for (let i = 0; i < 30 && codexHere.status === 'starting'; i++) await sleep(500); return send(res, 200, state()); }
    if (route === 'finish') { updateSetup({ done: true }); return send(res, 200, state()); }
    if (route === 'skip') { updateSetup({ skipped: true }); return send(res, 200, state()); }
    return send(res, 404, { error: 'unknown step' });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
}

const PAGE = fs.readFileSync(new URL('./setup.html', import.meta.url), 'utf8');

function proxy(req, res) {
  const up = http.request({ host: '127.0.0.1', port: UP, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.statusMessage, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('CloudCLI is starting. Try again in a moment.\n'); } else res.destroy();
  });
  req.pipe(up);
}

const settled = () => { const s = readSetup(); return s.done || s.skipped || !!process.env.CLAUDE_CODE_OAUTH_TOKEN; };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/setup' || url.pathname === '/setup/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE);
    }
    if (url.pathname.startsWith('/setup/api/')) return await api(req, res, url.pathname.slice('/setup/api/'.length));
    if (req.method === 'GET' && url.pathname === '/' && /text\/html/.test(req.headers.accept || '') && !settled()) {
      res.writeHead(302, { location: '/setup', 'cache-control': 'no-store' });
      return res.end();
    }
    return proxy(req, res);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(UP, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(raw + '\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
server.listen(PORT, '0.0.0.0', () => say(`listening on ${PORT}, CloudCLI on ${UP}`));
