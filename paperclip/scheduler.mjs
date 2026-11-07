// AvgSoft's Paperclip + CloudCLI template: the command of Paperclip's "Scheduler" agent (the process adapter: no AI,
// no cost). Paperclip's MCP server has no tools for routines, so an assistant on someone's own computer (or a person in
// the dashboard) manages the scheduled jobs by giving the Scheduler a task. Each line of the task's description that
// starts with a command (list, create, update, pause, resume, archive, run, runs, log) is run with the scheduled-jobs
// script, the same one Claude uses in CloudCLI, so jobs get the same rules; the output is posted as one comment and the
// task is closed, or marked blocked when a command failed. The task is read and closed with the run's own key; the
// script uses the board API key Paperclip's wiring stored for it (SCHEDULED_JOBS_CONFIG). CloudCLI's watch then
// records the jobs in their repos' .claude/jobs.json.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const JOBS = path.join(path.dirname(new URL(import.meta.url).pathname), 'scheduled-jobs', 'jobs.mjs');
const COMMANDS = ['repos', 'list', 'create', 'update', 'pause', 'resume', 'archive', 'run', 'runs', 'log'];
const HEADING = '**Scheduler**';
const API = (process.env.PAPERCLIP_API_URL || `http://127.0.0.1:${process.env.PORT || 3100}`).replace(/\/+$/, '').replace(/\/api$/, '');
const KEY = process.env.PAPERCLIP_API_KEY || '';
const ME = process.env.PAPERCLIP_AGENT_ID || '';
const log = (m) => console.log(`[scheduler] ${m}`);

async function api(method, p, body) {
  const headers = { authorization: `Bearer ${KEY}`, accept: 'application/json' };
  if (process.env.PAPERCLIP_RUN_ID) headers['x-paperclip-run-id'] = process.env.PAPERCLIP_RUN_ID;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}/api${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${(json?.error || json?.message || text).toString().slice(0, 300)}`);
  return json;
}
const arr = (j) => (Array.isArray(j) ? j : j?.items || j?.data || j?.comments || []);

// A command line as words, with "double" or 'single' quotes (curly quotes too); no shell is involved.
function words(line) {
  const out = [];
  let cur = null;
  let quote = null;
  for (const ch of line.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur ??= ''; continue; }
    if (/\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    cur = (cur ?? '') + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// The commands in a task: lines starting with a command word, after any `node .../jobs.mjs`, `$` or backticks.
function commands(text) {
  return String(text || '').split('\n')
    .map((l) => l.trim().replace(/^`+|`+$/g, '').replace(/^\$\s*/, '').replace(/^node\s+\S*jobs\.mjs\s+/, '').trim())
    .map(words)
    .filter((w) => COMMANDS.includes(String(w[0] || '').toLowerCase()))
    .map((w) => [w[0].toLowerCase(), ...w.slice(1)]);
}

const HELP = [
  'No command found. Put one command per line in the task\'s description, for example:',
  '',
  '    repos',
  '    list',
  '    create "Daily report" --prompt "Run the daily-report skill." --cron "0 9 * * 1-5" --tz Europe/Paris --repo owner/name',
  '    run "Daily report"',
  '',
  `Commands: ${COMMANDS.join(', ')}. The Scheduler agent's description in Paperclip has the rules.`,
  'Something to do once is not a job: give it to the Runner agent as a task instead.',
].join('\n');

const show = (w) => w.map((x) => (/[\s"']/.test(x) || !x ? JSON.stringify(x) : x)).join(' ');

async function handle(task) {
  const issue = await api('GET', `/issues/${task.id}`);
  // A task already answered (the run stopped before closing it) is only closed: its commands never run twice.
  const answered = arr(await api('GET', `/issues/${task.id}/comments?limit=50`))
    .some((c) => c.authorAgentId === ME && String(c.body || '').startsWith(HEADING));
  let ok = true;
  if (!answered) {
    const list = commands(issue.description).length ? commands(issue.description) : commands(issue.title);
    const parts = [];
    if (!list.length) { ok = false; parts.push(HELP); }
    for (const w of list) {
      const r = spawnSync(process.execPath, [JOBS, ...w], { encoding: 'utf8', timeout: 10 * 60e3, env: process.env, maxBuffer: 8 << 20 });
      const output = `${r.stdout || ''}${r.stderr ? `${r.stdout ? '\n' : ''}${r.stderr}` : ''}`.trim() || (r.error ? r.error.message : '(no output)');
      parts.push(`\`\`\`text\n$ ${show(w)}\n${output.slice(-12000)}\n\`\`\``);
      log(`${issue.identifier || task.id}: ${w[0]} ${r.status === 0 ? 'done' : `failed (exit ${r.status})`}`);
      if (r.status !== 0) { ok = false; break; }
    }
    const body = `${HEADING} ${ok ? 'ran' : 'stopped at a failed command'}${list.length ? ` (${list.length} command${list.length > 1 ? 's' : ''})` : ''}:\n\n${parts.join('\n\n')}`;
    await api('POST', `/issues/${task.id}/comments`, { body });
  }
  await api('PATCH', `/issues/${task.id}`, { status: ok ? 'done' : 'blocked' });
}

async function main() {
  if (!KEY) { log('no PAPERCLIP_API_KEY: Paperclip runs this as the Scheduler agent'); process.exit(1); }
  const tasks = arr(await api('GET', '/agents/me/inbox-lite')).filter((t) => ['todo', 'in_progress'].includes(t.status));
  if (!tasks.length) { log('no open task'); return; }
  let failed = 0;
  for (const t of tasks.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))) {
    try { await handle(t); } catch (e) { failed++; log(`${t.identifier || t.id}: ${e.message}`); }
  }
  if (failed) process.exit(1);
}

main().catch((e) => { log(e.message); process.exit(1); });
