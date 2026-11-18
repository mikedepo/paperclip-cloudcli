// AvgSoft's Paperclip + CloudCLI template: the front process on CloudCLI's public port, as the node user.
// - Everything except /setup goes to CloudCLI unchanged (HTTP and WebSocket), which listens on an inner port.
// - /setup: the one-time setup page, behind CloudCLI's own login (the page reuses CloudCLI's sign-in token; the
//   password is only passed through to CloudCLI's login API, never stored). Steps, each one can be redone:
//   1. Claude, Codex, or both (either one finishes setup):
//      Claude: runs the official `claude setup-token` in a terminal and relays what it prints (the sign-in link) and
//      the code the user pastes back; the token it prints goes to Claude Code's user settings here and to Paperclip
//      (company secret CLAUDE_CODE_OAUTH_TOKEN, referenced by the Runner agent), with no redeploy.
//      Codex: Paperclip's own ChatGPT sign-in (a one-time code) for a "Codex" agent that runs jobs. Codex chats in
//      CloudCLI are off unless the user turns them on, since they run without permission prompts: then
//      `codex login --device-auth` here, a second code (one ChatGPT sign-in can't serve two servers).
//   2. GitHub: `gh auth login --web` (device code), then `gh auth setup-git`; the token becomes Paperclip's GITHUB_TOKEN.
//   3. Repos: adds a repo (never replaces one): clones it into the home folder and gives it its own project in
//      Paperclip, whose primary workspace it is, so each repo's jobs run on that repo.
//   4. Time zone: from the browser; used by the scheduled-jobs script and terminals here.
//   Optional, your own domains: the Railway steps for each app's custom domain, and checks of DNS, HTTPS and whether
//      Paperclip uses it yet. A CloudCLI domain that reaches this server is used at once.
// - Every 5 minutes, Paperclip's public address as Paperclip reports it, so links follow a new domain (layer.mjs).
// - Until setup is done or skipped, opening CloudCLI's home page redirects to /setup.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import {
  APP, CONFIG, H, addProject, bindRunnerSecrets, claudeSignedIn, cloneRepo, cloudcliUrl, codexIntent, codexSignedIn,
  connectCodexAgent, mcpCommand, mcpSetupUrl, mcpUrl, paperclipIssuer, paperclipPublicUrl, pc, publicDns, readJson, readSetup, refreshPaperclipUrl, repoInfo,
  repoProject, runnerContext, sameRepo, saveClaudeToken, timezone, updateSetup, upsertSecret, validZone, wireMemory, writeLayer, writePrivateJson,
  writeShellZone,
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

// ---------- step 1, Codex: for Paperclip's jobs (Paperclip's own ChatGPT sign-in), and CloudCLI's chats if turned on ----------

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
  updateSetup({ codex: { done: true, at: new Date().toISOString() }, done: true });
  writeLayer();
  job.status = 'done';
  say(`Codex connected for Paperclip's jobs (agent "Codex" ${how})`);
  // Codex chats turned on while this code was waiting: their code next, while the user is still on ChatGPT's page.
  if (readSetup().codexChats?.on && !codexSignedIn()) {
    try { codexHereStart(); } catch (e) { say(`starting Codex's sign-in for CloudCLI failed (${e.message})`); }
  }
}

// Codex chats in CloudCLI are off unless the user turns them on (the owner's choice, 2026-11-17): Codex's sandbox
// can't start on Railway, so they run only in CloudCLI's Bypass Permissions mode, with no permission prompts. On: the
// user's consent (setup.json `codexChats`; the page then selects that mode in the browser), and Codex's sign-in here
// if it has none yet. Off: signs Codex out here (its chats and terminal); Paperclip's Codex jobs keep their own sign-in.
const codexBin = () => {
  const own = path.join(H, '.npm-global', 'bin', 'codex');
  return fs.existsSync(own) ? own : 'codex';
};
const codexBusy = () => !!codex && ['starting', 'waiting-user', 'saving'].includes(codex.status);
function codexChats(on) {
  if (on) {
    updateSetup({ codexChats: { on: true, at: new Date().toISOString() } });
    say('Codex chats turned on: they run in Bypass Permissions mode, without permission prompts');
    // While Paperclip's code for jobs waits, the chats' code follows it (codexSignIn), not alongside it.
    if (!codexSignedIn() && !codexBusy()) codexHereStart();
    return;
  }
  if (codexHere?.pty && ['starting', 'waiting-user'].includes(codexHere.status)) {
    codexHere.status = 'off';
    try { codexHere.pty.kill(); } catch {}
  }
  if (codexSignedIn()) {
    const r = spawnSync(codexBin(), ['logout'], { cwd: H, env: childEnv(), encoding: 'utf8', timeout: 30000 });
    if (codexSignedIn()) throw new Error(`Codex is still signed in here: codex logout ${r.error ? `failed (${r.error.message})` : `ended with ${(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 200)}`}`);
  }
  updateSetup({ codexChats: { on: false, at: new Date().toISOString() } });
  say('Codex chats turned off: Codex signed out of CloudCLI (Paperclip\'s Codex jobs are unchanged)');
}

// Codex in CloudCLI's chats and terminal: its own sign-in, here (a second one-time code). The same credential can't
// serve both: Codex's refresh tokens are single-use, so two copies would sign each other out.
let codexHere = null; // { status, url, code, error, pty, out }
function codexHereStart() {
  if (codexHere && ['starting', 'waiting-user'].includes(codexHere.status)) return;
  const pty = createRequire(path.join(APP, 'package.json'))('node-pty');
  const env = childEnv({ BROWSER: 'true' });
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[k];
  const job = { status: 'starting', url: null, code: null, error: null, out: '' };
  job.pty = pty.spawn(codexBin(), ['login', '--device-auth'], { name: 'xterm-256color', cols: 400, rows: 50, cwd: H, env });
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
    } else if (!['done', 'error', 'off'].includes(job.status)) {
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

// ---------- optional: your own domains ----------
// The user adds each domain in Railway (no Railway token here); this page gives the steps and checks the result. A
// CloudCLI domain whose HTTPS reaches this server is used at once (links, CLAUDE.md). Paperclip takes a domain only at
// its next start: Railway makes it its public domain (PAPERCLIP_PUBLIC_URL), and its start adds every earlier one to
// the hostnames it answers, so the Railway address keeps working.

const PORTS = {
  cloudcli: PORT,
  inner: UP, // CloudCLI itself, behind this page: Railway lists it too, but a domain on it would skip /setup
  paperclip: Number((() => { try { return new URL(process.env.PAPERCLIP_URL).port; } catch { return ''; } })()) || 3100,
};
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// "https://Cloud.Example.com/setup" -> "cloud.example.com"; '' clears; an error for anything else.
function domainOf(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (!s) return '';
  if (!HOST.test(s)) throw new Error(`"${String(raw).trim()}" isn't a domain name (such as cloudcli.example.com)`);
  if (/(^|\.)(railway\.app|railway\.internal)$/.test(s)) throw new Error(`${s} is a Railway address. Enter a domain of your own.`);
  return s;
}

// The domain's public DNS (layer.mjs publicDns). HTTPS is checked only once it works: from inside Railway, a domain
// added on one of its services can already answer while the public can't reach it.
const dnsCheck = publicDns;
const WAIT_DNS = { ok: false, why: 'waits for the DNS record', wait: true };

async function httpsGet(host, p) {
  try {
    const r = await fetch(`https://${host}${p}`, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const text = await r.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, fallback: r.headers.get('x-railway-fallback') === 'true', json, text: text.slice(0, 300) };
  } catch (e) {
    return { error: String(e.cause?.code || e.name || e.message) };
  }
}

// Why HTTPS doesn't reach the app yet, or null when something answered for this domain.
function notReached(r, app, d) {
  if (r.error === 'ENOTFOUND' || r.error === 'EAI_AGAIN') return 'no DNS record yet';
  if (d.elsewhere && (r.error || r.status !== 200)) return "it doesn't reach Railway: the DNS record points elsewhere";
  if (r.error && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(r.error)) return "its HTTPS certificate isn't ready yet: Railway issues it a few minutes after it sees the DNS record";
  if (r.error) return `no answer (${r.error})`;
  if (r.fallback) return `Railway doesn't send it to ${app} yet: add it as a custom domain on the ${app} service`;
  return null;
}

// CloudCLI: a one-time nonce, answered by this process only (/setup/probe/<nonce>), proves the domain reaches this server.
const probes = new Set();
async function probeCloudcli(host) {
  const nonce = randomBytes(16).toString('hex');
  probes.add(nonce);
  const r = await httpsGet(host, `/setup/probe/${nonce}`);
  probes.delete(nonce);
  return { ok: r.status === 200 && r.json?.probe === nonce, r };
}
async function checkCloudcli(host) {
  const d = await dnsCheck(host);
  if (!d.ok) return { host, port: PORTS.cloudcli, dns: d, https: WAIT_DNS, inUse: false };
  const { ok, r } = await probeCloudcli(host);
  const why = ok ? null : notReached(r, 'CloudCLI', d)
    || `it answers, but not through this page (HTTP ${r.status}): in Railway, check that the domain's port is ${PORTS.cloudcli}`;
  return { host, port: PORTS.cloudcli, dns: d, https: { ok, why }, inUse: ok };
}
// The address works for browsers: public DNS, then this server's nonce through HTTPS.
async function cloudcliReached(host) {
  return (await dnsCheck(host)).ok && (await probeCloudcli(host)).ok;
}

// Paperclip: its OAuth issuer through the domain is the one it reports over the private network (no key is sent to
// the domain). Before its next start Paperclip turns the name away with 403: it reached Paperclip, which must be
// redeployed to answer it.
async function checkPaperclip(host) {
  const [d, { issuer: reported, changed }] = await Promise.all([dnsCheck(host), refreshPaperclipUrl()]);
  if (changed) writeLayer();
  const issuer = reported || (await paperclipIssuer());
  const current = issuer || paperclipPublicUrl();
  if (!d.ok) return { host, port: PORTS.paperclip, dns: d, https: WAIT_DNS, inUse: current === `https://${host}`, current };
  const r = await httpsGet(host, '/.well-known/oauth-authorization-server');
  let ok = false;
  let why = notReached(r, 'Paperclip', d);
  let redeploy = false;
  if (!why) {
    if (r.status === 200 && r.json?.issuer) {
      ok = !!issuer && (() => { try { return new URL(r.json.issuer).origin === issuer; } catch { return false; } })();
      if (!ok) why = `it answers as another Paperclip (${String(r.json.issuer).slice(0, 100)})`;
    } else if (r.status === 403 && /hostname is not allowed/i.test(r.json?.error || r.text)) {
      redeploy = true;
      why = 'it reaches Paperclip, which answers this name after a redeploy';
    } else if (r.status === 503) {
      const h = await httpsGet(host, '/api/health');
      ok = h.status === 200 && !!h.json?.status;
      if (!ok) why = `it answers, but not as Paperclip (HTTP ${h.status || h.error})`;
    } else why = `it answers, but not as Paperclip (HTTP ${r.status})`;
  }
  return { host, port: PORTS.paperclip, dns: d, https: { ok, why, redeploy }, inUse: current === `https://${host}`, current };
}

async function checkDomains() {
  const saved = readSetup().domains || {};
  const out = {};
  await Promise.all([
    saved.cloudcli?.host && checkCloudcli(saved.cloudcli.host).then((c) => { out.cloudcli = c; }),
    saved.paperclip?.host && checkPaperclip(saved.paperclip.host).then((c) => { out.paperclip = c; }),
  ]);
  const now = new Date().toISOString();
  const next = { ...(readSetup().domains || {}) };
  if (out.cloudcli && next.cloudcli?.host === out.cloudcli.host) {
    next.cloudcli = { host: out.cloudcli.host, verified: out.cloudcli.inUse, checkedAt: now };
    if (out.cloudcli.inUse) next.lastWorking = out.cloudcli.host;
  }
  if (out.paperclip && next.paperclip?.host === out.paperclip.host) next.paperclip = { host: out.paperclip.host, checkedAt: now };
  const wasUrl = cloudcliUrl();
  updateSetup({ domains: next });
  if (cloudcliUrl() !== wasUrl) {
    writeLayer();
    say(`CloudCLI's address is now ${cloudcliUrl()}`);
  }
  return out;
}

async function saveDomains(b) {
  const saved = readSetup().domains || {};
  const next = { ...saved };
  for (const app of ['cloudcli', 'paperclip']) {
    if (!(app in b)) continue;
    const host = domainOf(b[app]);
    if (!host) delete next[app];
    else if (saved[app]?.host !== host) next[app] = { host };
  }
  if (next.cloudcli && next.cloudcli.host === next.paperclip?.host) throw new Error('CloudCLI and Paperclip need a domain each');
  const wasUrl = cloudcliUrl();
  updateSetup({ domains: next });
  if (cloudcliUrl() !== wasUrl) writeLayer();
  return checkDomains();
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
      chats: !!s.codexChats?.on, // the user turned Codex chats on (they run without permission prompts)
      here: {
        done: codexSignedIn(), status: codexHere?.status || null, error: codexHere?.error || null,
        url: codexHere?.status === 'waiting-user' ? codexHere.url : null, code: codexHere?.status === 'waiting-user' ? codexHere.code : null,
      },
    },
    paperclipConnected: !!cfg.token,
    links: { cloudcli: cloudcliUrl() || '/', paperclip: paperclipPublicUrl(), mcp: mcpUrl(), mcpSetup: mcpSetupUrl(), mcpCommand: mcpUrl() ? mcpCommand() : '' },
    domains: { cloudcli: s.domains?.cloudcli?.host || '', paperclip: s.domains?.paperclip?.host || '', ports: PORTS },
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
    if (route === 'codex/chats') {
      if (typeof b.on !== 'boolean') throw new Error('say on or off');
      if (b.on && b.accept !== true) throw new Error('Codex chats run without permission prompts: tick the box to accept that first.');
      codexChats(b.on);
      for (let i = 0; i < 30 && codexHere?.status === 'starting'; i++) await sleep(500);
      return send(res, 200, state());
    }
    // A new code for chats already turned on (an expired code, or a sign-in again after a plan change).
    if (route === 'codex/here') {
      if (!readSetup().codexChats?.on) throw new Error('Codex chats are off: turn them on first.');
      codexHereStart();
      for (let i = 0; i < 30 && codexHere.status === 'starting'; i++) await sleep(500);
      return send(res, 200, state());
    }
    if (route === 'domains') return send(res, 200, { checks: await saveDomains(b), state: state() });
    if (route === 'domains/check') return send(res, 200, { checks: await checkDomains(), state: state() });
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
    noteHost(req);
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/setup' || url.pathname === '/setup/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE);
    }
    if (url.pathname.startsWith('/setup/api/')) return await api(req, res, url.pathname.slice('/setup/api/'.length));
    // The own-domain check's probe: answers only a nonce this process is waiting for, so it tells nothing to others.
    if (url.pathname.startsWith('/setup/probe/')) {
      const nonce = url.pathname.slice('/setup/probe/'.length);
      return probes.has(nonce) ? send(res, 200, { probe: nonce }) : send(res, 404, { error: 'not found' });
    }
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

// Every 5 minutes (and soon after start), the apps' addresses (layer.mjs): Paperclip's as it reports it, Railway's
// public domain for CloudCLI and the user's own CloudCLI domain, each used once it reaches its app. So links, the MCP
// address and the CLAUDE.md block follow a domain change without a redeploy of CloudCLI, and never move to an address
// whose DNS record or certificate isn't ready.
async function watchAddresses() {
  const was = cloudcliUrl();
  const { changed } = await refreshPaperclipUrl();
  const env = process.env.RAILWAY_PUBLIC_DOMAIN;
  const own = readSetup().domains?.cloudcli?.host;
  const [envOk, ownOk] = await Promise.all([env && cloudcliReached(env), own && cloudcliReached(own)]);
  const next = { ...(readSetup().domains || {}) }; // read again: the card may have saved meanwhile
  if (env) {
    next.env = { host: env, ok: envOk };
    if (envOk) next.lastWorking = env;
  }
  if (own && next.cloudcli?.host === own) {
    next.cloudcli = { ...next.cloudcli, verified: ownOk };
    if (ownOk) next.lastWorking = own;
  }
  updateSetup({ domains: next });
  if (cloudcliUrl() !== was) say(`CloudCLI's address for links is now ${cloudcliUrl()}`);
  if (changed || cloudcliUrl() !== was) writeLayer();
}
// The Railway address of this service, as browsers use it (Railway's edge only sends this service the hosts it has).
let seenRailway = readSetup().domains?.railway || '';
function noteHost(req) {
  // Host, not X-Forwarded-Host: Railway's edge routes by Host, so it is always one of this service's domains, while a
  // forwarded header may carry what the visitor sent.
  const h = String(req.headers.host || '').trim().toLowerCase().replace(/:\d+$/, '');
  if (h === seenRailway || !/^[a-z0-9-]+\.up\.railway\.app$/.test(h)) return;
  seenRailway = h;
  try {
    const was = cloudcliUrl();
    updateSetup({ domains: { ...(readSetup().domains || {}), railway: h } });
    if (cloudcliUrl() !== was) writeLayer();
  } catch {}
}
const watch = () => watchAddresses().catch((e) => say(`checking the apps' addresses failed (${e.message})`));
setTimeout(watch, 20e3).unref();
setInterval(watch, 5 * 60e3).unref();
