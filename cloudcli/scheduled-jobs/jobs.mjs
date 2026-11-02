#!/usr/bin/env node
// The scheduled-jobs skill's script: this server's jobs, which are Paperclip routines run by the "Runner" agent.
// Talks to Paperclip's REST API over Railway's private network with the board API key the template stored in
// ~/.config/scheduled-jobs/paperclip.json. Part of AvgSoft's Paperclip + CloudCLI template; rewritten at every start.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE = `node jobs.mjs <command> [options]   (--json for raw output)
  list                                      every job: status, repo, schedule, next and last run
  create "<title>" --prompt "<prompt>" [--cron "<min hour dom mon dow>"] [--tz <IANA zone, default: the server's TZ>] [--paused] [--agent <name>] [--repo <name or owner/name>]
  update <job> [--title ...] [--prompt ...] [--cron ...] [--tz ...] [--repo ...]
  pause <job> | resume <job> | archive <job>
  run <job>                                 run it now
  runs <job> [--limit N]                    recent runs
  log <job> [--run N] [--full]              a run's task status, summary, tokens and cost, and its log (default: the latest run)
<job> is a job's title (any case) or the start of its ID.
A job runs on one repo: the one the current folder is in (its git remote), or the one --repo names.`;

const CONFIG = path.join(os.homedir(), '.config', 'scheduled-jobs', 'paperclip.json');
const argv = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['json', 'paused', 'full', 'help'].includes(k)) opts[k] = true;
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

async function api(method, p, body, { allow404 = false } = {}) {
  const headers = { authorization: `Bearer ${cfg.token}`, accept: 'application/json', origin: cfg.publicUrl || cfg.url };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(cfg.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch (e) { die(`Paperclip at ${cfg.url} did not answer (${e.cause?.code || e.message}). Is the Paperclip service running?`); }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (res.status === 404 && allow404) return null;
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

async function context(agentName = 'Runner') {
  const companies = arr(await api('GET', '/api/companies')).filter((c) => c.status !== 'archived');
  if (!companies.length) die('Paperclip has no company yet; the template creates "Jobs" at Paperclip\'s start (check its log for "[wiring]").');
  for (const company of companies) {
    const agents = arr(await api('GET', `/api/companies/${company.id}/agents`));
    const agent = agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase() && a.status !== 'terminated');
    if (agent) return { company, agent };
  }
  die(`No agent named "${agentName}" in Paperclip.`);
}

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

// The repo the current folder is in: its top folder and remote addresses, origin first. null outside a git repo.
function folderRepo() {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) return null;
  const dir = top.stdout.trim();
  const r = spawnSync('git', ['-C', dir, 'config', '--local', '--get-regexp', '^remote\\..*\\.url$'], { encoding: 'utf8' });
  const urls = (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/))
    .sort((a, b) => (b[0] === 'remote.origin.url') - (a[0] === 'remote.origin.url')).map((x) => x[1]);
  return { dir, urls };
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
    lines.push(`Agent ${agent.name} is ${agent.status}${agent.lifecycleError ? ` (${agent.lifecycleError})` : ''}: its runs wait. A new Claude agent stays paused until Paperclip's check of its Claude sign-in passes; the fix: connect Claude on ${SETUP_PAGE} (same login), which gives Paperclip the token and retries the agent (or sign in to Claude on the agent's configuration page in Paperclip and press Retry).`);
  }
  if (cfg.publicUrl) lines.push(`Job: ${link(`routines/${job.id}`)}`);
  out(res, lines.join('\n'));
}

const ctx = await context(cmd === 'create' && opts.agent ? opts.agent : 'Runner');
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
    out(full, rows.length ? rows.join('\n') : 'No jobs yet. Create one: create "<title>" --prompt "Run the <skill> skill." --cron "0 9 * * *" --tz <zone>');
    break;
  }
  case 'create': {
    const title = args[0];
    if (!title || !opts.prompt) die('Usage: create "<title>" --prompt "Run the <skill> skill." [--cron "0 9 * * *"] [--tz Europe/Paris] [--paused]');
    const project = await projectFor(company);
    const job = await api('POST', `/api/companies/${company.id}/routines`, {
      title,
      description: opts.prompt,
      assigneeAgentId: ctx.agent.id,
      projectId: project.id,
      priority: 'medium',
      status: opts.paused ? 'paused' : 'active',
      concurrencyPolicy: 'skip_if_active',
      catchUpPolicy: 'skip_missed',
    });
    if (opts.cron) await api('POST', `/api/routines/${job.id}/triggers`, { kind: 'schedule', cronExpression: opts.cron, timezone: opts.tz || ZONE });
    const full = await api('GET', `/api/routines/${job.id}`);
    out({ ...full, repo: repoOf(project) }, `Created job ${full.id.slice(0, 8)} "${full.title}" for ${ctx.agent.name} in project "${project.name}" (${projectRepos(project).length ? `repo ${repoOf(project)}` : 'no repo yet'}): ${scheduleText(full)}, ${full.status}. Test it: run "${full.title}". ${link(`routines/${full.id}`)}`);
    break;
  }
  case 'update': {
    const job = await findJob(company, args[0]);
    const patch = {};
    if (opts.title) patch.title = opts.title;
    if (opts.prompt) patch.description = opts.prompt;
    const moved = opts.repo ? await projectFor(company) : null;
    if (moved) patch.projectId = moved.id;
    if (Object.keys(patch).length) await api('PATCH', `/api/routines/${job.id}`, patch);
    if (opts.cron || opts.tz) await setSchedule(job, opts.cron, opts.tz);
    const full = await api('GET', `/api/routines/${job.id}`);
    out(full, `Updated "${full.title}": ${scheduleText(full)}, ${full.status}${moved ? `, repo ${repoOf(moved)}` : ''}`);
    break;
  }
  case 'pause':
  case 'resume':
  case 'archive': {
    const job = await findJob(company, args[0]);
    const status = { pause: 'paused', resume: 'active', archive: 'archived' }[cmd];
    const r = await api('PATCH', `/api/routines/${job.id}`, { status });
    out(r, `"${job.title}" is ${status}`);
    break;
  }
  case 'run': {
    const job = await findJob(company, args[0]);
    const r = await api('POST', `/api/routines/${job.id}/run`, { source: 'manual' });
    out(r, `Started "${job.title}": run ${String(r?.id || '').slice(0, 8)} ${r?.status || ''}. Read it with: log "${job.title}"`);
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
  default:
    die(USAGE);
}
