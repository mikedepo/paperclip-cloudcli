#!/usr/bin/env node
// The scheduled-jobs skill's script: this server's jobs, which are Paperclip routines run by the "Runner" agent
// (Claude) or the "Codex" agent (OpenAI's Codex), whichever the user connected; with both, the Runner by default.
// Talks to Paperclip's REST API over Railway's private network with the board API key the template stored in
// ~/.config/scheduled-jobs/paperclip.json. Part of AvgSoft's Paperclip + CloudCLI template; rewritten at every start.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE = `node jobs.mjs <command> [options]   (--json for raw output)
  list                                      every job: status, repo, schedule, next and last run
  create "<title>" --prompt "<prompt>" [--cron "<min hour dom mon dow>"] [--tz <IANA zone, default: the server's TZ>] [--paused] [--agent <name>] [--repo <name or owner/name>] [--secrets "NAME,NAME"]
  update <job> [--title ...] [--prompt ...] [--cron ...] [--tz ...] [--repo ...] [--agent ...] [--secrets ...]   (--secrets "" clears them)
  pause <job> | resume <job> | archive <job>
  run <job> [--wait]                        run it now; --wait: wait for the run to finish (up to 9 minutes), then print its log
  runs <job> [--limit N]                    recent runs
  log <job> [--run N] [--full]              a run's task status, summary, tokens and cost, and its log (default: the latest run)
  sync [--repo <name>]                      record every job in its repo's .claude/jobs.json (after changes made in Paperclip's dashboard)
  restore [--repo <name>] [--yes]           recreate the jobs the repos' .claude/jobs.json list that Paperclip doesn't have (a new server); without --yes, only shows them
  connectors [<service>]                    what exists for an outside service (telegram, slack, email...): Paperclip's apps, the connections set up, plugins; plugins on npm and MCP servers in the MCP registry
<job> is a job's title (any case) or the start of its ID.
A job runs on one repo: the one the current folder is in (its git remote), or the one --repo names.
Every change to a job is recorded in its repo's .claude/jobs.json, committed and pushed.
--agent: Runner (Claude) or Codex (OpenAI's Codex). Without it, create uses the Runner when Claude is connected for
Paperclip, and Codex when only Codex is.`;

const CONFIG = path.join(os.homedir(), '.config', 'scheduled-jobs', 'paperclip.json');
const SETUP = path.join(os.homedir(), '.config', 'paperclip-cloudcli', 'setup.json');
const argv = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['json', 'paused', 'full', 'help', 'yes', 'wait'].includes(k)) opts[k] = true;
    else opts[k] = argv[++i];
  } else pos.push(a);
}
const [cmd, ...args] = pos;
const die = (m) => { console.error(m); process.exit(1); };
if (!cmd || opts.help) { console.log(USAGE); process.exit(cmd ? 0 : 1); }

let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {
  die(`Not connected to Paperclip: ${CONFIG} is missing. It is written at CloudCLI's start; redeploy CloudCLI, then check its log for "[wiring]".`);
}

// soft: an error answer returns null instead of stopping the script.
async function api(method, p, body, { allow404 = false, soft = false } = {}) {
  const headers = { authorization: `Bearer ${cfg.token}`, accept: 'application/json', origin: cfg.publicUrl || cfg.url };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(cfg.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch (e) { die(`Paperclip at ${cfg.url} did not answer (${e.cause?.code || e.message}). Is the Paperclip service running?`); }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if ((res.status === 404 && allow404) || (!res.ok && soft)) return null;
  if (!res.ok) die(`${method} ${p} -> ${res.status}: ${(json?.error || json?.message || text).toString().slice(0, 400)}`);
  return json;
}
const arr = (j) => (Array.isArray(j) ? j : j?.items || j?.data || j?.runs || []);
const out = (data, text) => console.log(opts.json ? JSON.stringify(data, null, 2) : text);
// Times are shown in the server's time zone (TZ on the deploy form), the default for new jobs too.
const ZONE = (() => {
  const z = cfg.timezone || process.env.TZ || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return z; } catch { return 'UTC'; }
})();
const when = (t) => (t ? new Intl.DateTimeFormat('sv-SE', { timeZone: ZONE, dateStyle: 'short', timeStyle: 'short' }).format(new Date(t)) + ' ' + ZONE : '-');
// Links into Paperclip's dashboard for the user (same login as CloudCLI).
let PREFIX = '';
const link = (p) => (cfg.publicUrl ? `${cfg.publicUrl}/${PREFIX ? PREFIX + '/' : ''}${p}` : '');

// An agent whose runs go ahead: Paperclip's check of its sign-in passed and it isn't paused. The Runner of a server
// set up with Codex only fails that check (no Claude sign-in).
const ready = (a) => !!a && !['paused', 'error', 'terminated'].includes(a.status) && !a.lifecycleError && (!a.lifecycleState || a.lifecycleState === 'ready');

// The company and the agent a command works with: the one named, or, with no name (create without --agent), the
// Runner while it is ready, else Codex when it is (only Codex connected), else the Runner, whose jobs then wait.
async function context(agentName) {
  const companies = arr(await api('GET', '/api/companies')).filter((c) => c.status !== 'archived');
  if (!companies.length) die('Paperclip has no company yet; the template creates "Jobs" at Paperclip\'s start (check its log for "[wiring]").');
  for (const company of companies) {
    const agents = arr(await api('GET', `/api/companies/${company.id}/agents`)).filter((a) => a.status !== 'terminated');
    const named = (n) => agents.find((a) => a.name.toLowerCase() === n.toLowerCase());
    if (agentName) {
      if (named(agentName)) return { company, agent: named(agentName) };
      continue;
    }
    const runner = named('Runner');
    const codex = agents.find((a) => a.name === 'Codex' && a.adapterType === 'codex_local');
    if (!ready(runner) && ready(codex)) return { company, agent: codex, fallback: true };
    if (runner) return { company, agent: runner };
  }
  die(noAgent(agentName || 'Runner'));
}
const noAgent = (name) => (/^codex$/i.test(String(name))
  ? `No "Codex" agent in Paperclip yet: the user connects Codex (their ChatGPT account) in step 1 of ${SETUP_PAGE} (same login), which creates it. Then run this again.`
  : `No agent named "${name}" in Paperclip (the template's are "Runner", and "Codex" once connected on ${SETUP_PAGE}).`);

// ---- repos: each connected repo has its own Paperclip project, whose primary workspace it is ----

const SETUP_PAGE = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/setup` : "CloudCLI's /setup page";
// "host/owner/name" in lower case from an https or ssh git address ('' otherwise); GitHub names ignore case.
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
const projectRepos = (p) => arr(p.workspaces).filter((w) => w.repoUrl).sort((a, b) => (b.isPrimary === true) - (a.isPrimary === true));
// A project's repo as "owner/name" (its primary workspace's), or its name when it has no repo.
const repoOf = (p) => {
  const w = p && projectRepos(p)[0];
  if (!w) return p ? `${p.name} (no repo)` : '-';
  return String(w.repoUrl).replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).slice(-2).join('/');
};

async function projects(company, archived = false) {
  return arr(await api('GET', `/api/companies/${company.id}/projects${archived ? '?includeArchived=true' : ''}`)).filter((p) => archived || !p.archivedAt);
}

// A folder's remote addresses, origin first ([] when it isn't a git checkout).
function remotes(dir) {
  const r = spawnSync('git', ['-C', dir, 'config', '--local', '--get-regexp', '^remote\\..*\\.url$'], { encoding: 'utf8' });
  return (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/))
    .sort((a, b) => (b[0] === 'remote.origin.url') - (a[0] === 'remote.origin.url')).map((x) => x[1]);
}

// The repo the current folder is in: its top folder and remote addresses, origin first. null outside a git repo.
function folderRepo() {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) return null;
  const dir = top.stdout.trim();
  return { dir, urls: remotes(dir) };
}

// The clone on this server of a project's repo: the current folder when it is that repo, else the folder /setup
// cloned it into (~/<name>, or ~/<owner>-<name> when that was taken). null when there is none.
function cloneOf(project) {
  const url = project && projectRepos(project)[0]?.repoUrl;
  if (!url) return null;
  let added = [];
  try { added = JSON.parse(fs.readFileSync(SETUP, 'utf8')).repos || []; } catch {}
  const [owner, name] = repoOf(project).split('/');
  const dirs = [folderRepo()?.dir, ...added.map((r) => r.dir), path.join(os.homedir(), name), path.join(os.homedir(), `${owner}-${name}`)];
  return dirs.find((d) => d && remotes(d).some((u) => sameRepo(u, url))) || null;
}

// The project a job goes in: the one --repo names; else the project of the repo the current folder is in; else the
// only project. Several repos and no way to tell which: stop and list them, so Claude asks the user.
async function projectFor(company) {
  const all = await projects(company);
  if (!all.length) die('Paperclip has no project to put jobs in.');
  const withRepo = all.filter((p) => projectRepos(p).length);
  const pool = withRepo.length ? withRepo : all;
  const names = pool.map(repoOf).join(', ');
  if (opts.repo) {
    const want = String(opts.repo).trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
    const hits = pool.filter((p) => p.name.toLowerCase() === want || projectRepos(p).some((w) =>
      repoKey(opts.repo) ? sameRepo(w.repoUrl, opts.repo) : `/${repoKey(w.repoUrl)}`.endsWith(`/${want}`)));
    if (hits.length === 1) return hits[0];
    die(hits.length ? `--repo "${opts.repo}" matches several repos: ${hits.map(repoOf).join(', ')}. Name it as owner/name.`
      : `No connected repo "${opts.repo}". Connected: ${names}. Another repo is added on step 3 of ${SETUP_PAGE}.`);
  }
  const here = folderRepo();
  if (here?.urls.length) {
    const hit = pool.find((p) => projectRepos(p).some((w) => here.urls.some((u) => sameRepo(w.repoUrl, u))));
    if (hit) return hit;
    die(`The current folder is in the repo ${here.dir} (${here.urls[0]}), which isn't connected to Paperclip, so a job can't run its skills. Ask the user: connect it on step 3 of ${SETUP_PAGE}, or name one of the connected repos with --repo: ${names}.`);
  }
  if (pool.length === 1) return pool[0];
  die(`Which repo is this job for? Several are connected: ${names}. Run the script from that repo's folder, or pass --repo <name>; ask the user if it isn't clear.`);
}

async function routines(company) {
  return arr(await api('GET', `/api/companies/${company.id}/routines`)).filter((r) => r.status !== 'archived' || opts.all);
}

async function findJob(company, ref) {
  if (!ref) die('Name the job (its title or the start of its ID).');
  const all = arr(await api('GET', `/api/companies/${company.id}/routines`));
  const r = ref.toLowerCase();
  const hit = all.filter((j) => j.title.toLowerCase() === r);
  const byId = all.filter((j) => j.id.startsWith(r));
  const partial = all.filter((j) => j.title.toLowerCase().includes(r));
  const found = hit.length ? hit : byId.length ? byId : partial;
  if (found.length !== 1) die(found.length ? `"${ref}" matches ${found.length} jobs: ${found.map((j) => j.title).join(', ')}` : `No job "${ref}". Run: list`);
  return api('GET', `/api/routines/${found[0].id}`);
}

const schedules = (job) => arr(job.triggers).filter((t) => t.kind === 'schedule' && !t.archived);
const scheduleText = (job) => schedules(job).map((t) => `${t.cronExpression} ${t.timezone}${t.enabled === false ? ' (off)' : ''}`).join('; ') || 'run by hand only';

async function setSchedule(job, cron, tz) {
  const t = schedules(job)[0];
  if (t) return api('PATCH', `/api/routine-triggers/${t.id}`, { ...(cron ? { cronExpression: cron } : {}), ...(tz ? { timezone: tz } : {}) });
  if (!cron) die('This job has no schedule yet: give --cron.');
  return api('POST', `/api/routines/${job.id}/triggers`, { kind: 'schedule', cronExpression: cron, timezone: tz || ZONE });
}

async function jobRuns(job, limit) {
  return arr(await api('GET', `/api/routines/${job.id}/runs?limit=${limit}`));
}

function logText(content) {
  const lines = [];
  for (const raw of String(content || '').split('\n')) {
    if (!raw.trim()) continue;
    let chunk = raw, stream = 'stdout';
    try { const j = JSON.parse(raw); if (typeof j.chunk === 'string') { chunk = j.chunk; stream = j.stream || stream; } } catch {}
    for (const l of chunk.split('\n')) {
      if (!l.trim()) continue;
      // Claude Code's stream-json: show the text parts, not the event envelopes.
      let shown = l;
      try {
        const e = JSON.parse(l);
        if (e.type === 'result') shown = `[result] ${e.result ?? e.subtype}`;
        // Codex's `codex exec --json` events: its messages, and the commands it ran.
        else if (e.item && typeof e.item === 'object') {
          const it = e.item;
          shown = ['agent_message', 'reasoning'].includes(it.type) ? String(it.text || `[${it.type}]`)
            : it.type === 'command_execution' ? `[command] ${it.command}${it.exit_code != null ? ` (exit ${it.exit_code})` : ''}`
            : `[${it.type || e.type}]`;
        }
        else if (e.type === 'assistant') shown = arr(e.message?.content).filter((c) => c.type === 'text').map((c) => c.text).join(' ') || `[${arr(e.message?.content).map((c) => c.type === 'tool_use' ? `tool ${c.name}` : c.type).join(', ')}]`;
        else if (e.type) shown = `[${e.type}${e.subtype ? ' ' + e.subtype : ''}]`;
      } catch {}
      lines.push(stream === 'stderr' ? `[stderr] ${shown}` : shown);
    }
  }
  return lines;
}

async function showLog(job) {
  const runs = await jobRuns(job, 20);
  const run = runs[Number(opts.run || 1) - 1];
  if (!run) die('This job has no runs yet. Run: run <job>');
  const res = { run };
  const lines = [`Job "${job.title}", run of ${when(run.triggeredAt || run.createdAt)}: ${run.status}${run.failureReason ? ` (${run.failureReason})` : ''}`];
  if (run.linkedIssueId) {
    const issue = res.task = await api('GET', `/api/issues/${run.linkedIssueId}`);
    lines.push(`Task ${issue.identifier || issue.id}: ${issue.status}  ${link(`issues/${issue.identifier || issue.id}`)}`);
    const comments = arr(await api('GET', `/api/issues/${issue.id}/comments`));
    const last = comments[comments.length - 1];
    if (last) lines.push(`Summary: ${String(last.body || '').trim().slice(0, 600)}`);
    const beats = res.agentRuns = arr(await api('GET', `/api/issues/${issue.id}/runs`));
    for (const b of beats) {
      const u = b.usageJson || {};
      const tokens = ['inputTokens', 'cachedInputTokens', 'outputTokens'].filter((k) => u[k] != null).map((k) => `${k.replace('Tokens', '')} ${u[k]}`).join(', ');
      const cost = u.costUsd ?? u.cacheAdjustedCostUsd;
      const id = String(b.runId || b.id);
      lines.push(`Agent run ${id.slice(0, 8)}${b.retryOfRunId ? ` (follow-up of ${b.retryOfRunId.slice(0, 8)})` : ''}: ${b.status}, ${when(b.startedAt || b.createdAt)}` +
        `${tokens ? `, tokens: ${tokens}` : ''}${cost != null ? `, cost $${Number(cost).toFixed(4)}` : ''}${u.billingType && u.billingType !== 'unknown' ? ` (${u.billingType})` : ''}` +
        `${b.error ? `, error: ${String(b.error).slice(0, 200)}` : ''}`);
    }
    const latest = beats[0];
    if (latest) {
      const latestId = String(latest.runId || latest.id);
      const lg = await api('GET', `/api/heartbeat-runs/${latestId}/log`, undefined, { allow404: true });
      if (!lg) lines.push(`Agent run ${latestId.slice(0, 8)} has no log yet (${latest.status}).`);
      const text = lg ? logText(lg.content ?? lg) : [];
      res.log = text;
      if (lg) lines.push(`Log of agent run ${latestId.slice(0, 8)} (${link(`agents/${latest.agentId}/runs/${latestId}`)})${opts.full ? '' : ', last 30 lines (--full for all)'}:`);
      lines.push(...(opts.full ? text : text.slice(-30)).map((l) => `  ${l.slice(0, 300)}`));
    }
  }
  const agent = job.assigneeAgentId ? await api('GET', `/api/agents/${job.assigneeAgentId}`, undefined, { allow404: true }) : null;
  if (agent && (agent.status === 'paused' || agent.lifecycleError)) {
    lines.push(`Agent ${agent.name} is ${agent.status}${agent.lifecycleError ? ` (${agent.lifecycleError})` : ''}: its runs wait. ${agent.adapterType === 'codex_local'
      ? `The Codex agent waits until Paperclip's check of its ChatGPT sign-in passes; the fix: connect Codex again in step 1 of ${SETUP_PAGE} (same login), which signs it in and retries the agent.`
      : `A new Claude agent stays paused until Paperclip's check of its Claude sign-in passes; the fix: connect Claude on ${SETUP_PAGE} (same login), which gives Paperclip the token and retries the agent (or sign in to Claude on the agent's configuration page in Paperclip and press Retry).`}`);
  }
  if (cfg.publicUrl) lines.push(`Job: ${link(`routines/${job.id}`)}`);
  out(res, lines.join('\n'));
}

// ---- the record: each repo's .claude/jobs.json lists its jobs, committed and pushed at every change ----

// Paperclip runs the jobs; the record keeps what they are in git, in plain terms another scheduler can read, so they
// survive this server and can be recreated on a new one (restore).
const RECORD = '.claude/jobs.json';
const ABOUT = "Scheduled jobs on this repo, kept by the scheduled-jobs skill (https://github.com/mikedepo/paperclip-cloudcli): every change to a job is a commit of this file. Each job runs its prompt in this repo with Claude Code (the Runner agent), or with the agent its \"agent\" names (Codex: OpenAI's Codex), on its 5-field cron schedule in its time zone; paused jobs don't run. To recreate them on a new server: node ~/.claude/skills/scheduled-jobs/jobs.mjs restore";
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const gitError = (r) => String(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').filter(Boolean).pop() || `exit ${r.status}`;
const sameJob = (e, job) => (!!e.paperclipId && e.paperclipId === job.id) || String(e.title || '').toLowerCase() === job.title.toLowerCase();
const describe = (e) => `"${e.title}" (${(e.schedules || (e.cron ? [e] : [])).map((s) => `${s.cron} ${s.timezone || ZONE}`).join('; ') || 'run by hand only'}, ${e.status || 'active'}${e.secrets?.length ? `, needs ${e.secrets.join(', ')}` : ''})`;

function readRecord(dir) {
  const file = path.join(dir, RECORD);
  if (!fs.existsSync(file)) return { jobs: null };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.jobs)) throw new Error('it has no "jobs" list');
    return { jobs: data.jobs };
  } catch (e) { return { error: `${path.join(dir, RECORD)} isn't readable (${e.message})` }; }
}

const agentNames = new Map();
async function agentName(id) {
  if (!id) return null;
  if (id === ctx.agent.id) return ctx.agent.name;
  if (!agentNames.has(id)) agentNames.set(id, (await api('GET', `/api/agents/${id}`, undefined, { allow404: true }))?.name || null);
  return agentNames.get(id);
}

// The names (never the values) of the secrets and variables a job's skill needs. Paperclip binds them to the agent,
// not the job, so the record is where a job's list is kept; a new server learns from it what to set up.
const SECRETS = (() => {
  if (opts.secrets === undefined) return undefined;
  const names = String(opts.secrets).split(/[\s,]+/).filter(Boolean);
  const bad = names.filter((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  if (bad.length) die(`--secrets takes variable names (letters, digits, _), not values: ${bad.join(', ')}`);
  return [...new Set(names)];
})();
const withSecrets = (entry, secrets) => {
  const { secrets: _, paperclipId, ...rest } = entry;
  return { ...rest, ...(secrets?.length ? { secrets } : {}), paperclipId };
};

// The job's secrets its agent doesn't have, as a line for the user ('' when none is missing); for a Codex job, also
// the names Codex won't see: Paperclip keeps variables named *KEY*, *SECRET* or *TOKEN* out of Codex's commands.
async function missingSecrets(job, secrets) {
  if (!secrets?.length || !job.assigneeAgentId) return '';
  const agent = await api('GET', `/api/agents/${job.assigneeAgentId}`, undefined, { allow404: true });
  const hidden = agent?.adapterType === 'codex_local' ? secrets.filter((n) => /key|secret|token/i.test(n)) : [];
  const rename = hidden.length ? `Codex never sees ${hidden.join(', ')}: Paperclip keeps variables whose names contain KEY, SECRET or TOKEN out of its commands. Rename ${hidden.length > 1 ? 'them' : 'it'} in the skill and with --secrets, for example TELEGRAM_BOT instead of TELEGRAM_BOT_TOKEN.` : '';
  const missing = secrets.filter((n) => !(n in (agent?.adapterConfig?.env || {})) && !hidden.includes(n));
  // Paperclip adds a variable on the agent's Harness / Runtime page; its Secrets & variables page only lists them.
  return [rename, missing.length ? `"${job.title}" needs ${missing.join(', ')}, which ${agent?.name || 'its agent'} doesn't have yet. The user adds ${missing.length > 1 ? 'each' : 'it'} on ${agent?.name || 'the agent'}'s Harness / Runtime page in Paperclip${agent && link('') ? ` (${link(`agents/${agent.id}/runtime`)})` : ''}: under Environment variables, Add variable, type the name, then choose "Organization secret" and "Create new secret..." for a key or token, or "Text value" for a plain setting such as a chat ID, and Save changes.` : ''].filter(Boolean).join('\n');
}

// A job as the record keeps it: title, prompt, schedule, status; the agent only when it isn't the Runner.
async function entryOf(job) {
  const s = schedules(job).map((t) => ({ cron: t.cronExpression, timezone: t.timezone }));
  const e = { title: job.title, prompt: job.description || '' };
  if (s.length > 1) e.schedules = s;
  else Object.assign(e, s[0] || { cron: null });
  e.status = job.status;
  const agent = await agentName(job.assigneeAgentId);
  if (agent && agent.toLowerCase() !== 'runner') e.agent = agent;
  e.paperclipId = job.id;
  return e;
}

// Puts a job's entry in place of its old one (same Paperclip ID, or its title before the change), or at the end.
// The old entry's secrets are kept unless `secrets` replaces them.
const put = (job, entry, { oldTitle = job.title, secrets } = {}) => (jobs) => {
  const i = jobs.findIndex((x) => sameJob(x, job) || sameJob(x, { id: job.id, title: oldTitle }));
  const next = withSecrets(entry, secrets ?? jobs[i]?.secrets);
  return i < 0 ? [...jobs, next] : jobs.map((x, k) => (k === i ? next : x));
};
const drop = (job) => (jobs) => jobs.filter((x) => !sameJob(x, job));

async function projectJobs(project, archived = false) {
  const all = arr(await api('GET', `/api/companies/${company.id}/routines`)).filter((j) => j.projectId === project.id && (archived || j.status !== 'archived'));
  return Promise.all(all.map((j) => api('GET', `/api/routines/${j.id}`)));
}

// Rewrites a repo's record with edit(jobs), then commits and pushes that file alone. A repo with no record yet starts
// from every job its project has, so jobs from before the record are listed too. Returns a line for the user.
async function saveRecord(project, message, edit) {
  if (!project) return 'Not recorded: the job has no repo.';
  const where = `${repoOf(project)}'s ${RECORD}`;
  const dir = cloneOf(project);
  if (!dir) return `Not recorded: ${repoOf(project)} has no clone on this server (add it on step 3 of ${SETUP_PAGE}).`;
  git(dir, 'pull', '--ff-only', '--quiet'); // best effort: change the latest pushed record
  const rec = readRecord(dir);
  if (rec.error) return `Not recorded: ${rec.error}. Fix or delete the file, then run: sync`;
  const jobs = await edit(rec.jobs || await Promise.all((await projectJobs(project)).map(entryOf)));
  if (!rec.jobs && !jobs.length) return `No jobs in ${repoOf(project)}; nothing to record.`;
  const file = path.join(dir, RECORD);
  const text = JSON.stringify({ about: ABOUT, jobs }, null, 2) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return `Already recorded in ${where}.`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  let r = git(dir, 'add', '--force', RECORD);
  if (r.status === 0) r = git(dir, 'commit', '--quiet', '-m', message, '--', RECORD);
  if (r.status !== 0) return `Written to ${where}, not committed (${gitError(r)}): commit and push it.`;
  let p = git(dir, 'push', '--quiet');
  if (p.status !== 0) {
    // Someone pushed meanwhile: put this commit on top and push again.
    const rb = git(dir, 'pull', '--rebase', '--autostash', '--quiet');
    if (rb.status === 0) p = git(dir, 'push', '--quiet');
    else git(dir, 'rebase', '--abort');
  }
  const sha = git(dir, 'rev-parse', '--short', 'HEAD').stdout.trim();
  const branch = git(dir, 'branch', '--show-current').stdout.trim();
  const main = git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').stdout.trim().replace(/^origin\//, '');
  const off = branch && main && branch !== main ? `, on branch ${branch}: merge it into ${main} to keep the record there` : '';
  return p.status === 0 ? `Recorded in ${where}: commit ${sha}, pushed${off}.` : `Recorded in ${where}: commit ${sha}, not pushed (${gitError(p)}): push it.`;
}

async function newJob(project, { title, prompt, schedules: list = [], status = 'active', agentId = ctx.agent.id }) {
  const job = await api('POST', `/api/companies/${company.id}/routines`, {
    title,
    description: prompt,
    assigneeAgentId: agentId,
    projectId: project.id,
    priority: 'medium',
    status,
    concurrencyPolicy: 'skip_if_active',
    catchUpPolicy: 'skip_missed',
  });
  for (const s of list) await api('POST', `/api/routines/${job.id}/triggers`, { kind: 'schedule', cronExpression: s.cron, timezone: s.timezone || ZONE });
  return api('GET', `/api/routines/${job.id}`);
}

const projectById = async (id) => (id ? (await projects(company, true)).find((p) => p.id === id) || null : null);
const reposToCheck = async () => (opts.repo ? [await projectFor(company)] : (await projects(company)).filter((p) => projectRepos(p).length));

const ctx = await context(cmd === 'create' ? opts.agent : 'Runner');
const { company } = ctx;
PREFIX = company.issuePrefix || '';

switch (cmd) {
  case 'list': {
    const jobs = await routines(company);
    const byId = new Map((await projects(company, true)).map((p) => [p.id, p]));
    const full = (await Promise.all(jobs.map((j) => api('GET', `/api/routines/${j.id}`)))).map((j) => ({ ...j, repo: repoOf(byId.get(j.projectId)) }));
    const rows = [];
    for (const j of full) {
      const last = (await jobRuns(j, 1))[0];
      const next = schedules(j).map((t) => t.nextRunAt).filter(Boolean).sort()[0];
      rows.push(`${j.id.slice(0, 8)}  ${j.title}  [${j.status}]  repo: ${j.repo}  ${scheduleText(j)}  next: ${j.status === 'active' ? when(next) : '-'}  last: ${last ? `${when(last.triggeredAt || last.createdAt)} ${last.status}` : '-'}\n          ${String(j.description || '').split('\n')[0].slice(0, 160)}\n          ${link(`routines/${j.id}`)}`);
    }
    // Where the repos' records and Paperclip disagree: a new server (jobs only in a record) or dashboard edits.
    const notes = [];
    for (const p of await projects(company)) {
      const dir = cloneOf(p);
      const rec = dir ? readRecord(dir) : { jobs: null };
      if (rec.error) { notes.push(`${rec.error}.`); continue; }
      const live = full.filter((j) => j.projectId === p.id && j.status !== 'archived');
      const only = (rec.jobs || []).filter((e) => !live.some((j) => sameJob(e, j)));
      const stale = [];
      for (const j of live) {
        const e = (rec.jobs || []).find((x) => sameJob(x, j));
        if (!e || JSON.stringify(e) !== JSON.stringify(withSecrets(await entryOf(j), e.secrets))) stale.push(j.title);
        const lacking = await missingSecrets(j, e?.secrets);
        if (lacking) notes.push(lacking);
      }
      if (only.length) notes.push(`${repoOf(p)}'s ${RECORD} lists jobs Paperclip doesn't have: ${only.map(describe).join('; ')}. Recreate them with: restore`);
      if (dir && stale.length) notes.push(`Not recorded as they are now in ${repoOf(p)}'s ${RECORD}: ${stale.map((t) => `"${t}"`).join(', ')}. Record them with: sync`);
    }
    const text = rows.length ? rows.join('\n') : 'No jobs yet. Create one: create "<title>" --prompt "Run the <skill> skill." --cron "0 9 * * *" --tz <zone>';
    out(full, [text, ...notes].join('\n'));
    break;
  }
  case 'create': {
    const title = args[0];
    if (!title || !opts.prompt) die('Usage: create "<title>" --prompt "Run the <skill> skill." [--cron "0 9 * * *"] [--tz Europe/Paris] [--paused]');
    const project = await projectFor(company);
    const full = await newJob(project, { title, prompt: opts.prompt, schedules: opts.cron ? [{ cron: opts.cron, timezone: opts.tz }] : [], status: opts.paused ? 'paused' : 'active' });
    const record = await saveRecord(project, `Job "${full.title}" created: ${scheduleText(full)}, ${full.status}${SECRETS?.length ? `, needs ${SECRETS.join(', ')}` : ''}`, put(full, await entryOf(full), { secrets: SECRETS }));
    const lacking = await missingSecrets(full, SECRETS);
    const why = ctx.fallback ? `\nIt runs with Codex: Claude isn't connected for Paperclip's Runner. Once it is, the job can move with: update "${full.title}" --agent Runner` : '';
    out({ ...full, repo: repoOf(project), record }, `Created job ${full.id.slice(0, 8)} "${full.title}" for ${ctx.agent.name} in project "${project.name}" (${projectRepos(project).length ? `repo ${repoOf(project)}` : 'no repo yet'}): ${scheduleText(full)}, ${full.status}. Test it: run "${full.title}" --wait. ${link(`routines/${full.id}`)}${why}\n${record}${lacking ? `\n${lacking}` : ''}`);
    break;
  }
  case 'update': {
    const job = await findJob(company, args[0]);
    const patch = {};
    if (opts.title) patch.title = opts.title;
    if (opts.prompt) patch.description = opts.prompt;
    const moved = opts.repo ? await projectFor(company) : null;
    if (moved?.id === job.projectId) die(`"${job.title}" is already on ${repoOf(moved)}.`);
    if (moved) patch.projectId = moved.id;
    // --agent hands the job to another agent (Runner or Codex); the record keeps which.
    const handed = opts.agent ? arr(await api('GET', `/api/companies/${company.id}/agents`))
      .find((a) => a.name.toLowerCase() === String(opts.agent).toLowerCase() && a.status !== 'terminated') : null;
    if (opts.agent && !handed) die(noAgent(opts.agent));
    if (handed && handed.id !== job.assigneeAgentId) patch.assigneeAgentId = handed.id;
    if (Object.keys(patch).length) await api('PATCH', `/api/routines/${job.id}`, patch);
    if (opts.cron || opts.tz) await setSchedule(job, opts.cron, opts.tz);
    const full = await api('GET', `/api/routines/${job.id}`);
    const changes = [
      opts.title && full.title !== job.title ? `renamed from "${job.title}"` : '',
      opts.prompt ? 'new prompt' : '',
      patch.assigneeAgentId ? `run by ${handed.name}` : '',
      opts.cron || opts.tz ? `schedule ${scheduleText(full)}` : '',
      SECRETS ? (SECRETS.length ? `needs ${SECRETS.join(', ')}` : 'needs no secrets') : '',
    ].filter(Boolean).join(', ');
    const records = [];
    if (moved) {
      const from = await projectById(job.projectId);
      let carried; // the job's secrets, from the record it leaves
      if (from) records.push(await saveRecord(from, `Job "${job.title}" moved to ${repoOf(moved)}`, (jobs) => { carried = jobs.find((x) => sameJob(x, job))?.secrets; return drop(job)(jobs); }));
      records.push(await saveRecord(moved, `Job "${full.title}" moved here from ${from ? repoOf(from) : 'no repo'}${changes ? `: ${changes}` : ''}`, put(full, await entryOf(full), { oldTitle: job.title, secrets: SECRETS ?? carried })));
    } else {
      records.push(await saveRecord(await projectById(full.projectId), `Job "${full.title}" changed: ${changes || 'recorded again'}`, put(full, await entryOf(full), { oldTitle: job.title, secrets: SECRETS })));
    }
    const lacking = await missingSecrets(full, SECRETS);
    out({ ...full, record: records }, `Updated "${full.title}": ${scheduleText(full)}, ${full.status}${moved ? `, repo ${repoOf(moved)}` : ''}${handed ? `, run by ${handed.name}` : ''}\n${records.join('\n')}${lacking ? `\n${lacking}` : ''}`);
    break;
  }
  case 'pause':
  case 'resume':
  case 'archive': {
    const job = await findJob(company, args[0]);
    const status = { pause: 'paused', resume: 'active', archive: 'archived' }[cmd];
    await api('PATCH', `/api/routines/${job.id}`, { status });
    const full = await api('GET', `/api/routines/${job.id}`);
    const record = await saveRecord(await projectById(full.projectId), `Job "${full.title}" ${status}`, status === 'archived' ? drop(full) : put(full, await entryOf(full)));
    out({ ...full, record }, `"${job.title}" is ${status}\n${record}`);
    break;
  }
  case 'sync': {
    const lines = [];
    for (const p of await reposToCheck()) {
      const all = await projectJobs(p, true);
      const live = all.filter((j) => j.status !== 'archived');
      const archived = all.filter((j) => j.status === 'archived');
      const entries = await Promise.all(live.map(entryOf));
      let only = [];
      lines.push(await saveRecord(p, 'Jobs recorded as they are in Paperclip', (jobs) => {
        // Archived jobs leave the record; jobs Paperclip doesn't have (a new server) stay, for restore.
        let next = jobs.filter((x) => live.some((j) => sameJob(x, j)) || !archived.some((j) => sameJob(x, j)));
        live.forEach((j, i) => { next = put(j, entries[i])(next); });
        only = next.filter((x) => !live.some((j) => sameJob(x, j)));
        return next;
      }));
      if (only.length) lines.push(`  Only in the record, not in Paperclip: ${only.map(describe).join('; ')}. Recreate with: restore --repo ${repoOf(p)}; or, if no longer wanted, remove ${only.length > 1 ? 'them' : 'it'} from the file and commit.`);
    }
    out(lines, lines.join('\n') || 'No repo is connected.');
    break;
  }
  case 'restore': {
    const lines = [];
    const agents = arr(await api('GET', `/api/companies/${company.id}/agents`)).filter((a) => a.status !== 'terminated');
    for (const p of await reposToCheck()) {
      const dir = cloneOf(p);
      if (!dir) { lines.push(`${repoOf(p)}: no clone on this server.`); continue; }
      git(dir, 'pull', '--ff-only', '--quiet');
      const rec = readRecord(dir);
      if (rec.error) { lines.push(`${rec.error}.`); continue; }
      if (!rec.jobs?.length) { lines.push(`${repoOf(p)}: no jobs recorded.`); continue; }
      const all = await projectJobs(p, true);
      const live = all.filter((j) => j.status !== 'archived');
      const todo = [];
      for (const e of rec.jobs.filter((x) => !live.some((j) => sameJob(x, j)))) {
        const archived = all.find((j) => j.status === 'archived' && j.id === e.paperclipId);
        const agent = e.agent ? agents.find((a) => a.name.toLowerCase() === String(e.agent).toLowerCase()) : ctx.agent;
        if (archived) lines.push(`${repoOf(p)}: "${e.title}" was archived in Paperclip's dashboard; skipped. Run sync to drop it from the record.`);
        else if (!e.title || !e.prompt) lines.push(`${repoOf(p)}: an entry without a title or prompt; skipped.`);
        else if (!agent) lines.push(`${repoOf(p)}: "${e.title}" is for the agent "${e.agent}", which Paperclip doesn't have; skipped.${/^codex$/i.test(String(e.agent)) ? ` Connect Codex in step 1 of ${SETUP_PAGE}, then restore again.` : ''}`);
        else todo.push({ e, agent });
      }
      if (!todo.length) { lines.push(`${repoOf(p)}: nothing to recreate (${rec.jobs.length} recorded).`); continue; }
      if (!opts.yes) { lines.push(`${repoOf(p)}: would recreate ${todo.map(({ e }) => describe(e)).join('; ')}. Run again with --yes to do it.`); continue; }
      const made = [];
      for (const { e, agent } of todo) {
        made.push(await newJob(p, { title: e.title, prompt: e.prompt, schedules: e.schedules || (e.cron ? [e] : []), status: e.status === 'paused' ? 'paused' : 'active', agentId: agent.id }));
      }
      const entries = await Promise.all(made.map(entryOf));
      lines.push(`${repoOf(p)}: recreated ${made.map((j) => `"${j.title}" (${scheduleText(j)}, ${j.status})`).join('; ')}.`);
      for (const [i, j] of made.entries()) {
        const lacking = await missingSecrets(j, todo[i].e.secrets);
        if (lacking) lines.push(lacking);
      }
      lines.push(await saveRecord(p, `Jobs recreated in Paperclip: ${made.map((j) => `"${j.title}"`).join(', ')}`, (jobs) => made.reduce((next, j, i) => put(j, entries[i])(next), jobs)));
    }
    out(lines, lines.join('\n') || 'No repo is connected.');
    break;
  }
  case 'run': {
    const job = await findJob(company, args[0]);
    const r = await api('POST', `/api/routines/${job.id}/run`, { source: 'manual' });
    if (!opts.wait) {
      out(r, `Started "${job.title}": run ${String(r?.id || '').slice(0, 8)} ${r?.status || ''}. Read it with: log "${job.title}"`);
      break;
    }
    // Finished: its task is done, blocked or cancelled and no agent run on it is still queued or running (Paperclip
    // may start a follow-up run to close a task), or the run never got a task (skipped, failed).
    if (!opts.json) console.log(`Started "${job.title}", waiting for it to finish...`);
    const until = Date.now() + 9 * 60e3; // under the 10 minutes a Claude Code command may take
    let finished = false;
    while (!finished && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 10000));
      const run = (await jobRuns(job, 20)).find((x) => x.id === r?.id);
      if (!run?.linkedIssueId) { finished = !!run && /skip|fail|error|cancel/i.test(run.status || ''); continue; }
      const task = await api('GET', `/api/issues/${run.linkedIssueId}`);
      const beats = arr(await api('GET', `/api/issues/${run.linkedIssueId}/runs`));
      finished = ['done', 'blocked', 'cancelled'].includes(task.status) && !beats.some((b) => ['queued', 'running'].includes(b.status));
    }
    if (!finished && !opts.json) console.log(`Still running after 9 minutes; the log so far (read the rest later with: log "${job.title}"):`);
    await showLog(job);
    break;
  }
  case 'runs': {
    const job = await findJob(company, args[0]);
    const runs = await jobRuns(job, Number(opts.limit || 10));
    out(runs, runs.length ? runs.map((r, i) => `${i + 1}. ${when(r.triggeredAt || r.createdAt)}  ${r.status}  ${r.source || ''}${r.failureReason ? `  (${r.failureReason})` : ''}`).join('\n') : 'No runs yet.');
    break;
  }
  case 'log': {
    await showLog(await findJob(company, args[0]));
    break;
  }
  case 'connectors': {
    // What Paperclip already has for an outside service a job needs (connectors.md says how to choose). Read-only.
    const q = args.join(' ').trim().toLowerCase();
    const hit = (...xs) => !q || xs.flat().some((x) => String(x || '').toLowerCase().includes(q));
    const how = (m) => (m.purpose === 'channel' ? 'channel (people reach one agent through it, and it answers there)'
      : m.purpose === 'ai' ? 'AI model sign-in' : `tools for agents (${m.transport})`);
    const apps = arr((await api('GET', `/api/companies/${company.id}/tools/gallery`, undefined, { soft: true }))?.apps)
      .filter((a) => hit(a.slug, a.name, a.description, a.categories) && (q || !(a.methods || []).every((m) => m.purpose === 'ai')));
    const conns = arr((await api('GET', `/api/companies/${company.id}/tools/connections`, undefined, { soft: true }))?.connections)
      .filter((c) => hit(c.name, c.uid, c.config?.sourceTemplateKey));
    const plugins = arr(await api('GET', '/api/plugins', undefined, { soft: true }));
    const tools = arr(await api('GET', '/api/plugins/tools', undefined, { soft: true }));
    const lines = [`Paperclip apps${q ? ` for "${q}"` : ''}: ${apps.length || 'none'}`];
    for (const a of apps) lines.push(`  ${a.name} (${a.slug}): ${[...new Set((a.methods || []).map(how))].join('; ')}. ${a.description || ''}`);
    lines.push(`Connections set up${q ? ` for "${q}"` : ''}: ${conns.length || 'none'}`);
    for (const c of conns) lines.push(`  ${c.name} (${c.transport || '?'}, ${c.status || '?'}${c.enabled === false ? ', off' : ''})`);
    lines.push(`Plugins installed: ${plugins.length || 'none'}`);
    for (const p of plugins) {
      const own = tools.filter((t) => t.pluginId === p.id || String(t.name || '').startsWith(`${p.pluginKey}:`));
      lines.push(`  ${p.manifestJson?.displayName || p.pluginKey || p.packageName} ${p.version || ''} [${p.status}]${own.length ? `, tools: ${own.map((t) => t.name).join(', ')}` : ''}`);
    }
    if (cfg.publicUrl) lines.push(`Apps page: ${link('apps')} (your own MCP server: ${link('apps/byo')}). Plugins: ${link('company/settings/instance/plugins')}`);
    // What others published for the service: Paperclip plugins on npm and servers in the official MCP registry.
    // Leads, not recommendations: connectors.md says what to check before suggesting one.
    let npm = null;
    let mcps = null;
    if (q) {
      const get = async (u) => {
        try { const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); return r.ok ? await r.json() : null; } catch { return null; }
      };
      const found = await get(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`paperclip plugin ${q}`)}&size=25`);
      npm = found && arr(found.objects).map((o) => o.package).filter((p) => /paperclip/i.test(p.name) && hit(p.name, p.description, p.keywords));
      const reg = await get(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(q)}&version=latest&limit=10`);
      mcps = reg && arr(reg.servers).map((s) => s.server).filter(Boolean);
      const about = (t) => (String(t || '').startsWith('[![') ? '' : String(t || '').slice(0, 120));
      lines.push(`Paperclip plugins on npm for "${q}": ${npm ? npm.length || 'none' : 'npm did not answer'}`);
      for (const p of npm || []) lines.push(`  ${p.name} ${p.version} (${String(p.date || '').slice(0, 10)}): ${about(p.description)} ${p.links?.repository || p.links?.npm || ''}`);
      lines.push(`MCP servers in the MCP registry for "${q}": ${mcps ? mcps.length || 'none' : 'the registry did not answer'}`);
      for (const s of mcps || []) {
        const where = s.remotes?.[0]?.url ? `hosted at ${s.remotes[0].url}` : s.packages?.[0] ? `${s.packages[0].registryType} package ${s.packages[0].identifier}` : '';
        lines.push(`  ${s.name}: ${about(s.title || s.description)}${where ? `, ${where}` : ''} ${s.repository?.url || ''}`);
      }
      if (npm?.length || mcps?.length) lines.push('Check one before suggesting it: fit, our Paperclip version, upkeep, and what it can reach (connectors.md).');
    }
    if (q && !apps.length && !conns.length && !plugins.length && !npm?.length && !mcps?.length) lines.push(`Nothing for "${q}" yet: weigh an inline call in the skill against a custom connector (connectors.md in this skill).`);
    out({ apps, connections: conns, plugins, tools, npm, mcpRegistry: mcps }, lines.join('\n'));
    break;
  }
  default:
    die(USAGE);
}
