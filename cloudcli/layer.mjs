// Shared by wire.mjs (at every start) and front.mjs (the /setup page) on the CloudCLI service, as the node user:
// the repo clone and shared-memory wiring, CloudCLI's project list, the setup state, the scheduled-jobs connection
// file, and the instruction layer (the ~/.claude/CLAUDE.md block and the scheduled-jobs skill). Own names only.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const H = '/home/node';
export const APP = path.join(H, '.npm-global', 'lib', 'node_modules', '@cloudcli-ai', 'cloudcli');
export const CONFIG = path.join(H, '.config', 'scheduled-jobs', 'paperclip.json');
export const SETUP = path.join(H, '.config', 'paperclip-cloudcli', 'setup.json');
const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), 'scheduled-jobs');
const SKILL_DIR = path.join(H, '.claude', 'skills', 'scheduled-jobs');
export const log = (m) => console.log(`[wiring] ${m}`);
export const cloudcliUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';
export const paperclipPublicUrl = (process.env.PAPERCLIP_PUBLIC_URL || '').replace(/\/+$/, '');
// Paperclip's MCP server, for assistants on people's own computers (Paperclip's wiring turns it on at every start).
export const mcpUrl = paperclipPublicUrl ? `${paperclipPublicUrl}/mcp/paperclip` : '';
export const mcpSetupUrl = paperclipPublicUrl ? `${paperclipPublicUrl}/mcp/setup` : '';
export const mcpCommand = `claude mcp add --transport http paperclip ${mcpUrl || '<Paperclip public URL>/mcp/paperclip'}`;

export function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writePrivateJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
// setup.json held one repo as `repo` before several were supported; it is read as the list `repos`.
export function readSetup() {
  const s = readJson(SETUP);
  if (!Array.isArray(s.repos)) s.repos = s.repo?.url ? [s.repo] : [];
  delete s.repo;
  return s;
}
export function updateSetup(patch) {
  const next = { ...readSetup(), ...patch };
  writePrivateJson(SETUP, next);
  return next;
}

// ---------- Paperclip, with the board API key wire.mjs stored ----------

export async function pc(method, p, body) {
  const cfg = readJson(CONFIG);
  if (!cfg.token || !cfg.url) throw new Error('not connected to Paperclip yet (CloudCLI connects at start; try again in a minute)');
  const headers = { authorization: `Bearer ${cfg.token}`, accept: 'application/json', origin: cfg.publicUrl || cfg.url };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(cfg.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`Paperclip ${method} ${p.split('?')[0]}: ${res.status}${typeof json?.error === 'string' ? ` (${json.error.slice(0, 200)})` : ''}`);
  return json;
}
export const arr = (j) => (Array.isArray(j) ? j : j?.items || j?.data || []);

export async function runnerContext() {
  for (const company of arr(await pc('GET', '/api/companies')).filter((c) => c.status !== 'archived')) {
    const runner = arr(await pc('GET', `/api/companies/${company.id}/agents`)).find((a) => a.name === 'Runner' && a.status !== 'terminated');
    if (!runner) continue;
    return { company, runner };
  }
  throw new Error('Paperclip has no Runner agent yet (Paperclip creates it at start; try again in a minute)');
}

export async function upsertSecret(company, name, value) {
  const existing = arr(await pc('GET', `/api/companies/${company.id}/secrets`)).find((s) => s.name === name);
  if (existing) { await pc('POST', `/api/secrets/${existing.id}/rotate`, { value }); return existing.id; }
  return (await pc('POST', `/api/companies/${company.id}/secrets`, { name, value })).id;
}

// The Runner's environment variable -> the company secret it comes from. A run gets only what is bound on its agent:
// Paperclip uses the GITHUB_TOKEN company secret for its own checkouts, not inside runs (where, with no GitHub
// connection set up in Paperclip, git and gh would look for a GitHub login of Paperclip's own that doesn't exist).
// GH_PAT too: Paperclip's native runner never passes GH_TOKEN or GITHUB_TOKEN to a run; the gh wrapper on Paperclip's
// service (its start.sh) uses GH_PAT for gh and git when neither is set.
export const RUNNER_SECRETS = { CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_CODE_OAUTH_TOKEN', GH_TOKEN: 'GITHUB_TOKEN', GITHUB_TOKEN: 'GITHUB_TOKEN', GH_PAT: 'GITHUB_TOKEN' };
// The Codex agent's: GitHub only. Its ChatGPT sign-in is Paperclip's own AI connection, bound in its runtimeConfig.
// Paperclip keeps variables named *KEY*, *SECRET* or *TOKEN* out of Codex's commands, so the token is also GH_PAT,
// which the gh wrapper on Paperclip's service (its start.sh) uses for gh and git.
export const CODEX_SECRETS = { GH_TOKEN: 'GITHUB_TOKEN', GITHUB_TOKEN: 'GITHUB_TOKEN', GH_PAT: 'GITHUB_TOKEN' };

// The env block with every `map` secret that exists bound as a secret_ref; `bound` lists the names newly bound.
function secretEnv(secrets, map, current = {}) {
  const env = { ...current };
  const bound = [];
  for (const [key, name] of Object.entries(map)) {
    const secret = secrets.find((s) => s.name === name);
    if (!secret || (env[key]?.type === 'secret_ref' && env[key].secretId === secret.id)) continue;
    env[key] = { type: 'secret_ref', secretId: secret.id, version: 'latest' };
    bound.push(key);
  }
  return { env, bound };
}

// Binds every RUNNER_SECRETS secret that exists on the Runner, and every CODEX_SECRETS one on the Codex agent when
// there is one. Paperclip's PATCH replaces the whole env block, so it is read and written back whole (Paperclip
// restores any value it shows redacted). Returns the names newly bound.
export async function bindRunnerSecrets() {
  const { company, runner } = await runnerContext();
  const secrets = arr(await pc('GET', `/api/companies/${company.id}/secrets`));
  const agent = await pc('GET', `/api/agents/${runner.id}`);
  const { env, bound } = secretEnv(secrets, RUNNER_SECRETS, agent?.adapterConfig?.env || {});
  if (bound.length) await pc('PATCH', `/api/agents/${runner.id}`, { adapterConfig: { env } });
  const codex = await codexAgent(company);
  let codexBound = [];
  if (codex) {
    const full = await pc('GET', `/api/agents/${codex.id}`);
    const c = secretEnv(secrets, CODEX_SECRETS, full?.adapterConfig?.env || {});
    if (c.bound.length) await pc('PATCH', `/api/agents/${codex.id}`, { adapterConfig: { env: c.env } });
    codexBound = c.bound;
  }
  return { runner, bound, codex, codexBound };
}

// ---------- Codex (optional): jobs run with the user's ChatGPT account ----------
// The sign-in is Paperclip's own (its local AI sign-in: `codex login --device-auth` on Paperclip's server, the
// credential kept encrypted as Paperclip's AI connection and refreshed by Paperclip); this page only relays the
// one-time code. The "Codex" agent is created here once signed in, bound to that connection, so Paperclip's check of
// it passes at once; Paperclip's own wiring keeps it at every start (codex.md, its working folder).
export const CODEX_AGENT = 'Codex';
export const CODEX_CONNECTION = 'ChatGPT (Codex jobs)';
const CODEX_MD = new URL('./codex.md', import.meta.url); // published from paperclip/codex.md, as on Paperclip

export async function codexAgent(company) {
  return arr(await pc('GET', `/api/companies/${company.id}/agents`))
    .find((a) => a.name === CODEX_AGENT && a.adapterType === 'codex_local' && a.status !== 'terminated') || null;
}

// What Paperclip's sign-in is for: a company-shared ChatGPT connection, the same one again on a redo.
export async function codexIntent(company) {
  const known = arr((await pc('GET', `/api/companies/${company.id}/ai-connections`))?.connections)
    .find((c) => c.provider === 'openai' && c.method === 'subscription' && c.ownership === 'shared' && c.name === CODEX_CONNECTION);
  return {
    provider: 'openai', method: 'subscription', name: CODEX_CONNECTION, ownership: 'shared', agentIds: [], allAgents: true,
    ...(known ? { connectionId: known.id } : {}),
  };
}

// Creates the Codex agent on the saved connection, or binds the existing one to it and retries Paperclip's check.
export async function connectCodexAgent({ connectionId, grantId }) {
  const { company, runner } = await runnerContext();
  const binding = { provider: 'openai', method: 'subscription', mode: 'shared', connectionId, grantId };
  const existing = await codexAgent(company);
  if (!existing) {
    const r = await pc('GET', `/api/agents/${runner.id}`);
    const { env } = secretEnv(arr(await pc('GET', `/api/companies/${company.id}/secrets`)), CODEX_SECRETS);
    const agent = await pc('POST', `/api/companies/${company.id}/agents`, {
      name: CODEX_AGENT,
      role: 'general',
      title: 'Runs scheduled jobs with Codex',
      capabilities: 'Runs the repo skill each scheduled job names, then closes its task.',
      adapterType: 'codex_local',
      // Paperclip 2026.1106 puts new Codex agents on its native runner, which drops the CLI engine; keep the legacy one.
      runner: 'legacy',
      // The CLI engine runs the real codex CLI (`codex exec`), as the Runner runs the real claude CLI. No sandbox or
      // approvals, as the Runner skips permissions: nobody is there to approve, and the job follows a written skill.
      // No model: Codex's own default, which OpenAI keeps valid for ChatGPT sign-in; one picked in Paperclip is kept.
      adapterConfig: { engine: 'cli', cwd: r?.adapterConfig?.cwd, dangerouslyBypassApprovalsAndSandbox: true, env },
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true }, aiConnection: binding },
      instructionsBundle: { entryFile: 'AGENTS.md', files: { 'AGENTS.md': fs.readFileSync(CODEX_MD, 'utf8') } },
    });
    log(`created Paperclip's "${CODEX_AGENT}" agent on the ChatGPT sign-in`);
    return { agent, how: 'created' };
  }
  const agent = await pc('GET', `/api/agents/${existing.id}`);
  if (JSON.stringify(agent.runtimeConfig?.aiConnection) !== JSON.stringify(binding)) {
    await pc('PATCH', `/api/agents/${agent.id}`, { runtimeConfig: { ...(agent.runtimeConfig || {}), aiConnection: binding } });
  }
  await pc('POST', `/api/agents/${agent.id}/lifecycle/retry`, {}).catch(() => {});
  return { agent, how: 'reconnected' };
}

// Codex in CloudCLI's chats and terminal signs in on its own (`codex login --device-auth` here).
export const codexSignedIn = () => fs.existsSync(path.join(process.env.CODEX_HOME || path.join(H, '.codex'), 'auth.json'));

export function validZone(z) {
  if (!z) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; }
}
// The zone chosen on /setup wins over TZ from the deploy form; UTC otherwise.
export function timezone() {
  const fromSetup = readSetup().timezone;
  if (validZone(fromSetup)) return fromSetup;
  const fromEnv = (process.env.TZ || '').trim();
  return validZone(fromEnv) ? fromEnv : 'UTC';
}

// A repo address as "host/owner/name" in lower case (GitHub names ignore case), from an https or ssh git address;
// '' when it isn't one. Two addresses name the same repo when their keys match.
export function repoKey(raw) {
  raw = String(raw || '').trim();
  const ssh = raw.match(/^(?:ssh:\/\/)?[\w.-]+@([^:/]+)[:/](.+)$/);
  if (ssh) raw = `https://${ssh[1]}/${ssh[2]}`;
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`.toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  } catch { return ''; }
}
export const sameRepo = (a, b) => !!repoKey(a) && repoKey(a) === repoKey(b);

// A GitHub repo as "owner/name", a github.com URL, or any https git URL.
export function repoInfo(raw) {
  raw = (raw || '').trim();
  if (!raw) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) raw = `https://github.com/${raw}`;
  let u;
  try { u = new URL(raw); } catch { return { error: 'not a repo address' }; }
  if (u.protocol !== 'https:') return { error: 'the repo address must start with https://' };
  u.username = ''; u.password = ''; // a token goes in GitHub's sign-in, never in the URL
  const parts = u.pathname.replace(/\/+$/, '').split('/');
  const name = (parts.pop() || '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) return { error: 'the repo address has no repo name at the end' };
  const owner = (parts.pop() || '').replace(/[^A-Za-z0-9._-]/g, '');
  return { url: u.toString().replace(/\/+$/, '').replace(/\.git$/, ''), name, owner, dir: path.join(H, name) };
}

// The remote addresses of a checkout (none when it isn't one).
export function remotes(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return [];
  const r = spawnSync('git', ['-C', dir, 'config', '--local', '--get-regexp', '^remote\\..*\\.url$'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n').map((l) => l.split(/\s+/)[1]).filter(Boolean) : [];
}
const isCloneOf = (dir, url) => remotes(dir).some((u) => sameRepo(u, url));
// Where a repo is cloned: ~/<name>, or ~/<owner>-<name> when ~/<name> already holds something else (another owner's
// repo of the same name, or a folder of the user's). Names are compared ignoring case (GitHub's are), so the same repo
// typed in another case finds its clone. look: where a clone of it may already be; free: where a new one may go.
function cloneDirs(repo) {
  const names = [repo.name, `${repo.owner || 'repo'}-${repo.name}`];
  let entries = [];
  try { entries = fs.readdirSync(H); } catch {}
  const existing = entries.filter((e) => names.some((n) => n.toLowerCase() === e.toLowerCase())).map((e) => path.join(H, e));
  const stored = readSetup().repos.filter((r) => r.dir && sameRepo(r.url, repo.url)).map((r) => r.dir);
  const free = names.filter((n) => !entries.some((e) => e.toLowerCase() === n.toLowerCase())).map((n) => path.join(H, n));
  return { look: [...new Set([...stored, ...existing])], free };
}

// Clones the repo once and sets repo.dir to its clone (an existing clone when there is one).
export function cloneRepo(repo) {
  const { look, free } = cloneDirs(repo);
  const have = look.find((d) => isCloneOf(d, repo.url));
  if (have) { repo.dir = have; return { ok: true }; }
  if (!free.length) return { ok: false, error: `~/${repo.name} and ~/${repo.owner || 'repo'}-${repo.name} already exist and hold something else` };
  repo.dir = free[0];
  const tmp = `${repo.dir}.cloning`;
  fs.rmSync(tmp, { recursive: true, force: true });
  const r = spawnSync('git', ['clone', '--quiet', repo.url, tmp], {
    encoding: 'utf8', timeout: 20 * 60e3, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, error: (r.stderr || r.error?.message || 'git clone failed').trim().split('\n').pop() };
  }
  fs.renameSync(tmp, repo.dir);
  log(`cloned ${repo.url} into ${repo.dir}`);
  return { ok: true, cloned: true };
}

function mergeJson(file, values, mode) {
  let current = {};
  if (fs.existsSync(file)) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { log(`${file} is not valid JSON; left as is`); return false; }
  }
  const next = { ...current, ...values };
  if (JSON.stringify(next) === JSON.stringify(current)) return true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', mode ? { mode } : undefined);
  if (mode) fs.chmodSync(file, mode);
  return true;
}

export function wireMemory(repo) {
  const memory = path.join(repo.dir, '.claude', 'memory');
  if (!fs.existsSync(memory)) return false;
  mergeJson(path.join(repo.dir, '.claude', 'settings.local.json'), { autoMemoryDirectory: memory });
  const exclude = path.join(repo.dir, '.git', 'info', 'exclude');
  const lines = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!lines.split('\n').includes('.claude/settings.local.json')) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${lines && !lines.endsWith('\n') ? '\n' : ''}.claude/settings.local.json\n`);
  }
  return true;
}

// The repo shows up in CloudCLI's project list (CloudCLI's own table; the same insert its "add project" does).
export function addProject(repo) {
  try {
    const Database = createRequire(path.join(APP, 'package.json'))('better-sqlite3');
    const db = new Database(path.join(H, '.cloudcli', 'auth.db'));
    db.pragma('busy_timeout = 5000');
    db.prepare('INSERT INTO projects (project_id, project_path, custom_project_name, isArchived) VALUES (?, ?, ?, 0) ON CONFLICT(project_path) DO NOTHING')
      .run(randomUUID(), repo.dir, path.basename(repo.dir));
    db.close();
    return true;
  } catch (e) {
    log(`could not add ${repo.dir} to CloudCLI's projects (${e.message})`);
    return false;
  }
}

// Claude Code reads a token from its user settings' env block (CloudCLI's sign-in check does too), so a token from
// /setup reaches CloudCLI's chats and terminals with no redeploy.
export function saveClaudeToken(token) {
  return mergeJson(path.join(H, '.claude', 'settings.json'), { env: { ...(readJson(path.join(H, '.claude', 'settings.json')).env || {}), CLAUDE_CODE_OAUTH_TOKEN: token } }, 0o600);
}
// What creating and checking a job needs, approved once so a first job doesn't stop at five permission prompts.
// CloudCLI's chat honors Claude Code's user settings on the server (in every browser, unlike its own "Allow &
// remember"). Each rule is seeded once: a rule the user removes later stays removed, and a rule added in a later
// version reaches existing servers at their next start. Everything else still asks.
const JOB_RULES = [
  'Bash(node /home/node/.claude/skills/scheduled-jobs/jobs.mjs:*)', 'Bash(node ~/.claude/skills/scheduled-jobs/jobs.mjs:*)',
  'Monitor', 'Edit', 'Write',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git pull:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
  'Bash(gh issue list:*)', 'Bash(gh issue view:*)', 'Bash(gh pr list:*)', 'Bash(gh pr view:*)',
  // 2026-11-04: the read-only GitHub commands Claude uses to check what a test run did.
  'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)', 'Bash(gh repo view:*)', 'Bash(gh run list:*)', 'Bash(gh run view:*)', 'Bash(gh auth status:*)',
];
const FIRST_RULES = 16; // servers seeded before 2026-11-04 recorded only `permissionsSeeded: true`
export function seedJobPermissions() {
  const was = readSetup().permissionsSeeded;
  const seeded = was === true ? JOB_RULES.slice(0, FIRST_RULES) : arr(was);
  const add = JOB_RULES.filter((r) => !seeded.includes(r));
  if (!add.length) return false;
  const file = path.join(H, '.claude', 'settings.json');
  const settings = readJson(file);
  const allow = [...new Set([...(settings.permissions?.allow || []), ...add])];
  mergeJson(file, { permissions: { ...(settings.permissions || {}), allow } }, 0o600);
  updateSetup({ permissionsSeeded: [...seeded, ...add] });
  return true;
}

export function claudeSignedIn() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  if (readJson(path.join(H, '.claude', 'settings.json')).env?.CLAUDE_CODE_OAUTH_TOKEN) return true;
  return fs.existsSync(path.join(H, '.claude', '.credentials.json'));
}

// Terminals (and Claude's shell) use the zone chosen on /setup without a redeploy.
export function writeShellZone(zone) {
  const file = path.join(H, '.bashrc');
  const mark = '# paperclip-cloudcli-tz';
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const kept = old.split('\n').filter((l) => !l.endsWith(mark)).join('\n').replace(/\n*$/, '\n');
  fs.writeFileSync(file, `${kept}export TZ=${zone} ${mark}\n`);
}

// The connected repos that have a clone here, each once: REPO_URL's (the advanced route) and those added on /setup.
export function repos() {
  const list = [];
  for (const want of [{ url: process.env.REPO_URL }, ...readSetup().repos]) {
    const r = repoInfo(want.url);
    if (!r || r.error || list.some((x) => sameRepo(x.url, r.url))) continue;
    const dir = want.dir && fs.existsSync(path.join(want.dir, '.git')) ? want.dir : cloneDirs(r).look.find((d) => isCloneOf(d, r.url));
    if (dir && !list.some((x) => x.dir === dir)) list.push({ ...r, dir });
  }
  return list;
}

// The Paperclip project a repo's jobs go in, one project per repo: the project that already has the repo as a
// workspace; else, for the first repo, the empty project Paperclip's wiring made at its first start (renamed after
// the repo); else a new project named after the repo, with the repo as its primary workspace. Never changes the
// workspaces of a project that has a repo. Paperclip checks the repo out itself at the project's first job.
const WIRED_PROJECT = 'Scheduled jobs on this server.'; // the description Paperclip's wire.mjs gives its project
export async function repoProject(repo) {
  const { company } = await runnerContext();
  const projects = arr(await pc('GET', `/api/companies/${company.id}/projects`)).filter((p) => !p.archivedAt);
  const holder = projects.find((p) => arr(p.workspaces).some((w) => sameRepo(w.repoUrl, repo.url)));
  if (holder) return { project: holder, how: 'reused' };
  const workspace = { name: repo.name, repoUrl: repo.url, isPrimary: true };
  const first = !projects.some((p) => arr(p.workspaces).some((w) => w.repoUrl));
  const empty = first && projects.filter((p) => !arr(p.workspaces).length)
    .sort((a, b) => (b.description === WIRED_PROJECT) - (a.description === WIRED_PROJECT))[0];
  if (empty) {
    await pc('POST', `/api/projects/${empty.id}/workspaces`, workspace);
    if (empty.name !== repo.name) await pc('PATCH', `/api/projects/${empty.id}`, { name: repo.name }).catch(() => {});
    log(`${repo.url} is the repo of Paperclip's project "${repo.name}" (it had none)`);
    return { project: { ...empty, name: repo.name }, how: 'took-over' };
  }
  const taken = projects.some((p) => p.name.toLowerCase() === repo.name.toLowerCase());
  const name = taken && repo.owner ? `${repo.owner}/${repo.name}` : repo.name;
  const project = await pc('POST', `/api/companies/${company.id}/projects`, { name, description: `Scheduled jobs on ${repo.url}.`, workspace });
  log(`created Paperclip's project "${name}" for ${repo.url}`);
  return { project, how: 'created' };
}

export function writeLayer() {
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(SKILL_DIR, f));
  const setup = readSetup();
  const lines = [
    '# This server',
    '',
    "- A Railway server from AvgSoft's Paperclip + CloudCLI template: CloudCLI (this app; the home folder is kept on a volume) and Paperclip, which runs the scheduled jobs.",
  ];
  const setupPage = `${cloudcliUrl || "CloudCLI's address"}/setup`;
  const picked = repos();
  if (picked.length) {
    lines.push(`- The user's ${picked.length > 1 ? 'repos are' : 'repo is'} cloned here, each with its own project in Paperclip, where its jobs run on Paperclip's own checkout of it:`);
    for (const repo of picked) {
      const memory = fs.existsSync(path.join(repo.dir, '.claude', 'memory'));
      const recorded = readJson(path.join(repo.dir, '.claude', 'jobs.json'), {}).jobs?.length || 0;
      lines.push(`  - \`${repo.dir}\` (from ${repo.url})${memory ? "; Claude's shared memory is its `.claude/memory/`, committed with the repo" : ''}${recorded ? `; its \`.claude/jobs.json\` records ${recorded} job${recorded > 1 ? 's' : ''}` : ''}.`);
    }
    lines.push("- Each repo's `.claude/jobs.json` records its jobs (title, prompt, schedule, status); the scheduled-jobs script commits and pushes it at every change. Paperclip runs the jobs and git keeps them: on a new server, the script's `restore` recreates them. When a repo records jobs that the script's `list` doesn't show, tell the user and offer to restore them.");
    lines.push(`- A job belongs to the repo of the current chat: write its skill in that repo, and the scheduled-jobs script puts the job in that repo's project (it reads the current folder's git remote; \`--repo\` names another). When the chat isn't in one of these repos, or it's unclear which repo a job is for, ask the user. More repos can be added any time on step 3 of ${setupPage}.`);
  } else {
    lines.push(`- No repo is picked yet, and jobs need one: each job runs a skill from it, pulled before every run. Send the user to step 3 of ${setupPage} rather than wiring one yourself: it clones the repo here, connects it to Paperclip's project and wires the shared memory.`);
  }
  lines.push(`- Scheduled jobs run in Paperclip as the "Runner" agent, on its own checkout of the job's repo. Its dashboard is ${paperclipPublicUrl || "Paperclip's public URL"} (same login as here): give the user links to jobs and runs there; the scheduled-jobs script prints them.`);
  if (setup.codex?.done) {
    lines.push('- A "Codex" agent in Paperclip can also run jobs, with OpenAI\'s Codex on the user\'s ChatGPT account. Jobs use the Runner (Claude) unless the user asks for Codex; then the scheduled-jobs skill\'s `--agent Codex` gives the job to it. Codex reads the same skill file in the repo.');
  } else {
    lines.push(`- Jobs can also run with OpenAI's Codex instead of Claude, on the user's ChatGPT account, once the user connects it in the "Optional: Codex" card of ${setupPage}. Mention it only when the user asks for Codex, ChatGPT or OpenAI.`);
  }
  lines.push('- To list, create, change, pause, run or check jobs, use the `scheduled-jobs` skill.');
  lines.push(`- Jobs can also be managed from the user's own computer: an assistant there (Claude Code, Codex, others) connects to Paperclip's MCP server, ${mcpUrl || "Paperclip's public URL + /mcp/paperclip"}, approves the connection in the browser with the same login, and gives Paperclip's "Scheduler" agent the scheduled-jobs commands. For Claude Code: \`${mcpCommand}\`, then \`/mcp\`, paperclip, Authenticate. Other assistants: ${mcpSetupUrl || "Paperclip's /mcp/setup page"}. Give this when the user asks how to use it from their computer.`);
  lines.push("- Jobs made or changed outside the scheduled-jobs script (Paperclip's dashboard, an assistant through the MCP server) get the no-overlap and no-backlog rules and are recorded in their repo's `.claude/jobs.json` by this server within 5 minutes; `sync` records them at once.");
  lines.push(`- When the user greets you, asks what this is or what you can do, or seems unsure where to start, explain it in a few short lines. This server runs Claude on a schedule. They say in plain words what should be done and when; you write the job's instructions as a skill in their repo, schedule it in Paperclip and run it once to check. Paperclip then runs it on time and keeps every run: its status, what Claude did, and its usage, at ${paperclipPublicUrl || "Paperclip's address"} with the same login. They can also just work on their repo with you here, as with Claude Code anywhere. Then suggest two or three jobs that fit their repo (look at it first) and ask what they'd like.`);
  lines.push(`- The user's time zone is ${timezone()}: new jobs use it unless the user names another.`);
  if (!setup.claude?.done && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    lines.push(setup.codex?.done
      ? `- Claude isn't connected for Paperclip's Runner, so only jobs given to Codex (\`--agent Codex\`) run. To run jobs with Claude, send the user to step 1 of ${setupPage}.`
      : `- Setup isn't finished: Claude isn't connected for Paperclip's jobs yet. Send the user to step 1 of ${setupPage}.`);
  }
  lines.push(`- The setup page, ${setupPage} (same login as here), connects Claude and GitHub, adds repos, sets the time zone and, optionally, connects Codex; every step can be redone there.`);
  const block = `<!-- paperclip-cloudcli:start (rewritten at every start of this server; edit outside this block) -->\n${lines.join('\n')}\n<!-- paperclip-cloudcli:end -->`;
  const file = path.join(H, '.claude', 'CLAUDE.md');
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = /<!-- paperclip-cloudcli:start[\s\S]*?<!-- paperclip-cloudcli:end -->/;
  const next = re.test(old) ? old.replace(re, block) : `${block}\n${old ? `\n${old}` : ''}`;
  if (next !== old) fs.writeFileSync(file, next);
}
