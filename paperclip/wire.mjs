// AvgSoft's Paperclip + CloudCLI template: the wiring on the Paperclip service, run in the background at every start.
// 1. Clones REPO_URL into /paperclip/repos/<name> (once) and, when the repo has .claude/memory/, points Claude Code's
//    auto memory at it in the clone's .claude/settings.local.json (memory-sync.mjs keeps the machine-wide setting).
// 2. Signs in as the admin from the deploy form. When ADMIN_PASSWORD changed in Variables, sets it as the account's
//    password (checked by signing in; put back if that fails) and signs every browser out, as CloudCLI does.
// 3. Makes sure the company "Jobs", a project for REPO_URL's repo (one project per repo, as CloudCLI's /setup adds
//    them) and the "Runner" agent exist, keeps the Runner on the repo and its instructions current, and stores
//    GH_TOKEN as the company secret GITHUB_TOKEN. Never renames a project or changes one that holds another repo.
//    The optional "Codex" agent, once CloudCLI's /setup page has created it, is kept the same way (never created here).
// Idempotent: the IDs it created are kept in /paperclip/.bundle/state.json. Never prints the password or a token.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const log = (m) => console.log(`[wiring] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOME = process.env.PAPERCLIP_HOME || '/paperclip';
const STATE_FILE = path.join(HOME, '.bundle', 'state.json');
const RUNNER_MD = fs.readFileSync(new URL('./runner.md', import.meta.url), 'utf8');
const CODEX_MD = fs.readFileSync(new URL('./codex.md', import.meta.url), 'utf8');
const COMPANY = 'Jobs';
const AGENT = 'Runner';
const CODEX = 'Codex';
const base = `http://127.0.0.1:${process.env.PORT || 3100}`;
const publicUrl = (process.env.PAPERCLIP_PUBLIC_URL || '').trim().replace(/\/+$/, '');
const origin = publicUrl.startsWith('http') ? new URL(publicUrl).origin : base;
const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || '';
const ghToken = (process.env.GH_TOKEN || '').trim();

// ---- repo and shared memory ----

function repoInfo(raw) {
  raw = (raw || '').trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return { error: 'REPO_URL is not a URL' }; }
  if (u.protocol !== 'https:') return { error: 'REPO_URL must start with https://' };
  u.username = ''; u.password = ''; // a token goes in GH_TOKEN, never in the URL
  const name = path.basename(u.pathname.replace(/\/+$/, '')).replace(/\.git$/, '');
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) return { error: 'REPO_URL has no repo name at the end' };
  return { url: u.toString().replace(/\/+$/, ''), name, dir: path.join(HOME, 'repos', name) };
}

function cloneRepo(repo) {
  if (fs.existsSync(path.join(repo.dir, '.git'))) return true;
  if (fs.existsSync(repo.dir)) { log(`${repo.dir} exists and is not a git checkout; not cloning`); return false; }
  fs.mkdirSync(path.dirname(repo.dir), { recursive: true });
  const tmp = `${repo.dir}.cloning`;
  fs.rmSync(tmp, { recursive: true, force: true });
  const r = spawnSync('git', ['clone', '--quiet', repo.url, tmp], {
    encoding: 'utf8', timeout: 20 * 60e3, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const why = (r.stderr || r.error?.message || '').trim().split('\n').pop();
    log(`cloning ${repo.url} failed (${why}). A private repo needs GH_TOKEN. It is retried at the next start.`);
    return false;
  }
  fs.renameSync(tmp, repo.dir);
  log(`cloned ${repo.url} into ${repo.dir}`);
  return true;
}

function mergeJson(file, values) {
  let current = {};
  if (fs.existsSync(file)) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { log(`${file} is not valid JSON; left as is`); return; }
  }
  if (Object.entries(values).every(([k, v]) => current[k] === v)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...current, ...values }, null, 2) + '\n');
}

function wireMemory(repo) {
  const memory = repo && path.join(repo.dir, '.claude', 'memory');
  if (!memory || !fs.existsSync(memory)) return;
  mergeJson(path.join(repo.dir, '.claude', 'settings.local.json'), { autoMemoryDirectory: memory });
  const exclude = path.join(repo.dir, '.git', 'info', 'exclude');
  const lines = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!lines.split('\n').includes('.claude/settings.local.json')) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${lines && !lines.endsWith('\n') ? '\n' : ''}.claude/settings.local.json\n`);
  }
  log(`Claude's auto memory in ${repo.dir} is its .claude/memory/`);
}

// "host/owner/name" in lower case from an https or ssh git address ('' otherwise); as in CloudCLI's layer.mjs.
function repoKey(raw) {
  raw = String(raw || '').trim();
  const ssh = raw.match(/^(?:ssh:\/\/)?[\w.-]+@([^:/]+)[:/](.+)$/);
  if (ssh) raw = `https://${ssh[1]}/${ssh[2]}`;
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`.toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  } catch { return ''; }
}
const sameRepo = (a, b) => !!repoKey(a) && repoKey(a) === repoKey(b);

// ---- Paperclip API, as the admin ----

let cookie = '';
async function call(method, p, body) {
  const headers = { origin, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const set = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 300), set };
}
const list = (r) => (Array.isArray(r.json) ? r.json : r.json?.items || r.json?.data || []);
function must(r, what) {
  if (!r.ok) throw new Error(`${what} failed (${r.status}: ${r.text})`);
  return r.json;
}

async function signIn() {
  const r = await call('POST', '/api/auth/sign-in/email', { email, password });
  if (r.ok && r.set.length) cookie = r.set.join('; ');
  return r;
}

// ADMIN_PASSWORD changed in Variables: Better Auth can't change a password without the old one, so write the new
// hash with Better Auth's own hasher, then prove it by signing in; on failure the old hash goes back.
async function syncPassword() {
  const fromServer = createRequire('/app/server/package.json');
  const fromDb = createRequire('/app/packages/db/package.json');
  const { hashPassword } = await import(pathToFileURL(fromServer.resolve('better-auth/crypto')).href);
  const postgres = (await import(pathToFileURL(fromDb.resolve('postgres')).href)).default;
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`select a.id, a.user_id, a.password from account a join "user" u on u.id = a.user_id
      where lower(u.email) = ${email} and a.provider_id = 'credential'`;
    if (rows.length !== 1) return `no account for ADMIN_EMAIL ${email}`;
    const { id, user_id: userId, password: old } = rows[0];
    await sql`update account set password = ${await hashPassword(password)} where id = ${id}`;
    await sql`delete from session where user_id = ${userId}`;
    const r = await signIn();
    if (r.ok) { log('the admin password was changed to ADMIN_PASSWORD; every browser was signed out'); return null; }
    await sql`update account set password = ${old} where id = ${id}`;
    return `sign-in with the new password failed (${r.status}); the old password was kept`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function ensureCompany(state) {
  if (state.companyId) {
    const r = await call('GET', `/api/companies/${state.companyId}`);
    if (r.ok && r.json?.status !== 'archived') return r.json;
  }
  const found = list(await call('GET', '/api/companies')).find((c) => c.name === COMPANY && c.status !== 'archived');
  if (found) return found;
  const company = must(await call('POST', '/api/companies', { name: COMPANY, description: 'Scheduled jobs, run by the Runner agent.' }), 'creating the company');
  log(`created the company "${COMPANY}"`);
  return company;
}

async function ensureSecret(company, state) {
  if (!ghToken) return;
  const hash = crypto.createHash('sha256').update(ghToken).digest('hex');
  if (state.ghTokenHash === hash && state.secretCompanyId === company.id) return;
  const existing = list(await call('GET', `/api/companies/${company.id}/secrets`)).find((s) => s.name === 'GITHUB_TOKEN');
  const r = existing
    ? await call('POST', `/api/secrets/${existing.id}/rotate`, { value: ghToken })
    : await call('POST', `/api/companies/${company.id}/secrets`, { name: 'GITHUB_TOKEN', value: ghToken });
  if (!r.ok) { log(`storing GH_TOKEN as the company secret GITHUB_TOKEN failed (${r.status})`); return; }
  Object.assign(state, { ghTokenHash: hash, secretCompanyId: company.id });
  log(`${existing ? 'updated' : 'stored'} GH_TOKEN as the company secret GITHUB_TOKEN`);
}

// One project per repo, as CloudCLI's /setup page adds them (layer.mjs, repoProject). This wiring's own project (its
// ID in the state file; found by its description if the file is lost) is created at the first start, on REPO_URL's
// repo when there is one, else empty for /setup's first repo to take over. REPO_URL's repo goes in the project that
// already has it; else in the own project while that has no workspace; else in a new project named after it.
const OWN_PROJECT = 'Scheduled jobs on this server.';
async function ensureProject(company, repo, state) {
  const workspace = repo?.cloned ? { name: repo.name, cwd: repo.dir, repoUrl: repo.url, isPrimary: true } : null;
  const projects = list(await call('GET', `/api/companies/${company.id}/projects`)).filter((p) => !p.archivedAt);
  let own = (state.projectId && projects.find((p) => p.id === state.projectId)) || projects.find((p) => p.description === OWN_PROJECT) || null;
  if (!own) {
    const holder = workspace && projects.find((p) => (p.workspaces || []).some((w) => sameRepo(w.repoUrl, repo.url)));
    if (holder) return holder;
    const body = { name: repo?.name || COMPANY, description: OWN_PROJECT };
    if (workspace) body.workspace = workspace;
    own = must(await call('POST', `/api/companies/${company.id}/projects`, body), 'creating the project');
    state.projectId = own.id;
    log(`created the project "${body.name}"${workspace ? ` on ${repo.dir}` : ''}`);
    return own;
  }
  state.projectId = own.id;
  if (!workspace) return own;
  const holder = projects.find((p) => (p.workspaces || []).some((w) => w.cwd === repo.dir || sameRepo(w.repoUrl, repo.url)));
  if (holder) return holder;
  if (!(own.workspaces || []).length) {
    must(await call('POST', `/api/projects/${own.id}/workspaces`, workspace), 'adding the repo to the project');
    log(`added ${repo.dir} to the project "${own.name}"`);
    return own;
  }
  const taken = projects.some((p) => p.name.toLowerCase() === repo.name.toLowerCase());
  const owner = repoKey(repo.url).split('/').slice(-2, -1)[0];
  const name = taken && owner ? `${owner}/${repo.name}` : repo.name;
  const project = must(await call('POST', `/api/companies/${company.id}/projects`, { name, description: `Scheduled jobs on ${repo.url}.`, workspace }), 'creating the project');
  log(`created the project "${name}" on ${repo.dir} (the project "${own.name}" holds another repo)`);
  return project;
}

function signInHint(agent) {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !agent?.adapterConfig?.env?.CLAUDE_CODE_OAUTH_TOKEN) {
    log("Claude is not connected for the Runner yet: open CloudCLI's /setup page (same login) and connect Claude there; it takes effect without a redeploy.");
  }
}

async function ensureRunner(company, cwd, state) {
  let agent = null;
  if (state.agentId) {
    const r = await call('GET', `/api/agents/${state.agentId}`);
    if (r.ok && r.json?.status !== 'terminated') agent = r.json;
  }
  if (!agent) {
    agent = list(await call('GET', `/api/companies/${company.id}/agents`)).find((a) => a.name === AGENT && a.status !== 'terminated') || null;
  }
  if (!agent) {
    agent = must(await call('POST', `/api/companies/${company.id}/agents`, {
      name: AGENT,
      role: 'general',
      title: 'Runs scheduled jobs',
      capabilities: 'Runs the repo skill each scheduled job names, then closes its task.',
      adapterType: 'claude_local',
      // The CLI engine runs the real claude CLI, which reads CLAUDE_CODE_OAUTH_TOKEN and the repo's settings. Sonnet:
      // a job follows a written skill, and Opus would draw the subscription's limits down faster (Pro has little of
      // it). Set only here, so a model the user picks on the Runner's page in Paperclip is kept.
      adapterConfig: { engine: 'cli', cwd, dangerouslySkipPermissions: true, model: 'sonnet' },
      // Wakes only for its tasks (each job run), never on a timer.
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true } },
      instructionsBundle: { entryFile: 'AGENTS.md', files: { 'AGENTS.md': RUNNER_MD } },
    }), 'creating the Runner agent');
    log(`created the agent "${AGENT}" (Claude Code, working folder ${cwd})`);
    signInHint(agent);
    return agent;
  }
  // Paperclip checks a new Claude agent with a short test run and pauses it when Claude isn't signed in. Retry that
  // check at each start, so a token added later in Variables, or a sign-in made in Paperclip, takes effect.
  if (agent.lifecycleError) {
    const r = await call('POST', `/api/agents/${agent.id}/lifecycle/retry`, {});
    log(r.ok ? "retried Paperclip's check of the Runner (it runs Claude once)" : `retrying the Runner's check failed (${r.status})`);
    signInHint(agent);
  }
  if (agent.adapterConfig?.cwd !== cwd) {
    must(await call('PATCH', `/api/agents/${agent.id}`, { adapterConfig: { cwd } }), 'moving the Runner to the repo');
    log(`the Runner's working folder is now ${cwd}`);
  }
  await keepInstructions(agent, RUNNER_MD, AGENT);
  return agent;
}

// Rewrites an agent's AGENTS.md when it differs from the template's.
async function keepInstructions(agent, content, name) {
  const cur = await call('GET', `/api/agents/${agent.id}/instructions-bundle/file?path=AGENTS.md`);
  if (cur.json?.content === content) return;
  // Paperclip versions the entry file: an edit names the revision it replaces (or the hash of an unversioned file).
  const base = cur.json?.revision?.id ? { baseRevisionId: cur.json.revision.id }
    : cur.json?.contentHash ? { baseHash: cur.json.contentHash } : { baseRevisionId: null };
  must(await call('PUT', `/api/agents/${agent.id}/instructions-bundle/file`, { path: 'AGENTS.md', content, ...base }), `updating the ${name} agent's instructions`);
  log(`updated the ${name} agent's instructions`);
}

// The optional "Codex" agent (codex_local, the user's ChatGPT account): CloudCLI's /setup page creates it when the user
// connects Codex there (bound to that sign-in, so Paperclip's check of it passes at once); a server whose user never
// does has none, and nothing here creates it. Once it exists, it is kept like the Runner: its working folder, its
// instructions (codex.md) and a retry of Paperclip's check when it failed.
async function keepCodex(company, cwd, state) {
  let agent = null;
  if (state.codexAgentId) {
    const r = await call('GET', `/api/agents/${state.codexAgentId}`);
    if (r.ok && r.json?.status !== 'terminated') agent = r.json;
  }
  if (!agent) {
    const found = list(await call('GET', `/api/companies/${company.id}/agents`))
      .find((a) => a.name === CODEX && a.adapterType === 'codex_local' && a.status !== 'terminated');
    if (found) agent = must(await call('GET', `/api/agents/${found.id}`), 'reading the Codex agent');
  }
  if (!agent) { delete state.codexAgentId; return null; }
  state.codexAgentId = agent.id;
  if (agent.lifecycleError) {
    const r = await call('POST', `/api/agents/${agent.id}/lifecycle/retry`, {});
    log(r.ok ? "retried Paperclip's check of the Codex agent (it runs Codex once)" : `retrying the Codex agent's check failed (${r.status})`);
    if (!agent.runtimeConfig?.aiConnection) log("the Codex agent has no ChatGPT sign-in: connect Codex again on CloudCLI's /setup page (same login).");
  }
  if (agent.adapterConfig?.cwd !== cwd) {
    must(await call('PATCH', `/api/agents/${agent.id}`, { adapterConfig: { cwd } }), 'moving the Codex agent to the repo');
    log(`the Codex agent's working folder is now ${cwd}`);
  }
  await keepInstructions(agent, CODEX_MD, CODEX);
  return agent;
}

async function main() {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (!up) await sleep(5000);
  }
  if (!up) { log('Paperclip did not answer within 10 minutes; nothing wired. Redeploy to retry.'); return; }

  const tz = process.env.TZ;
  if (tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { log(`TZ "${tz}" is not a time zone name (use one like America/Toronto); clocks stay on UTC.`); } }

  const repo = repoInfo(process.env.REPO_URL);
  if (repo?.error) log(`${repo.error}; no repo cloned. Fix it in Variables and redeploy.`);
  else if (repo) { repo.cloned = cloneRepo(repo); if (repo.cloned) wireMemory(repo); }
  const usable = repo && !repo.error && repo.cloned ? repo : null;
  const cwd = usable ? usable.dir : path.join(HOME, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  if (!email || !password) { log('ADMIN_EMAIL or ADMIN_PASSWORD is empty; the company and the Runner agent were not set up.'); return; }
  let r = await signIn();
  if (r.status === 401) {
    const problem = await syncPassword().catch((e) => `could not update it: ${e.message}`);
    if (problem) { log(`signing in as ADMIN_EMAIL failed and ${problem}. Nothing else wired.`); return; }
  } else if (!r.ok) {
    log(`signing in as ADMIN_EMAIL failed (${r.status}); nothing else wired. Redeploy to retry.`);
    return;
  }

  const company = await ensureCompany(state);
  state.companyId = company.id;
  await ensureSecret(company, state);
  const project = await ensureProject(company, usable, state);
  const agent = await ensureRunner(company, cwd, state);
  state.agentId = agent.id;
  const codex = await keepCodex(company, cwd, state).catch((e) => { log(`keeping the Codex agent failed (${e.message}); retried at the next start`); return null; });
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  log(`ready: company "${company.name}", project "${project.name}", agent "${agent.name}"${codex ? ` and "${codex.name}"` : ''} in ${cwd}`);
}

main().catch((e) => log(`stopped: ${e.message}`));
