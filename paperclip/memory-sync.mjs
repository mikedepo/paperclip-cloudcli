// AvgSoft's Paperclip + CloudCLI template: keeps Claude's shared memory wired on the Paperclip service, as the node
// user, checking every minute. Paperclip checks each repo out itself when /setup adds it (under
// /paperclip/instances/default/projects/<company>/<project>/<repo>, one project per repo), at that project's first
// job, so the clones appear after the start.
// - Every checkout with .claude/memory/: autoMemoryDirectory in its own .claude/settings.local.json (git-excluded).
// - Claude Code's machine-wide settings file: runs with Paperclip's own AI sign-in read it instead (they ignore local
//   settings), but it applies to every run whatever its repo, and over each checkout's own setting. So it points at
//   the repo's memory (its most recently fetched checkout) only while every checkout here is of one repo; once
//   another repo is checked out, the setting is removed rather than sending one repo's jobs to another's memory.
// Started without the admin login in its environment.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.PAPERCLIP_HOME || '/paperclip';
const MANAGED = '/etc/claude-code/managed-settings.json';
const say = (m) => console.log(`[memory] ${m}`);

// Every repo checkout here, most recently fetched first.
function checkouts() {
  const found = [];
  const add = (dir) => { if (fs.existsSync(path.join(dir, '.git'))) found.push(dir); };
  const list = (dir) => { try { return fs.readdirSync(dir).map((n) => path.join(dir, n)); } catch { return []; } };
  for (const d of list(path.join(HOME, 'repos'))) add(d);
  for (const c of list(path.join(HOME, 'instances', 'default', 'projects'))) for (const p of list(c)) for (const r of list(p)) add(r);
  const fetched = (d) => { for (const f of ['FETCH_HEAD', 'HEAD']) { try { return fs.statSync(path.join(d, '.git', f)).mtimeMs; } catch {} } return 0; };
  return found.sort((a, b) => fetched(b) - fetched(a));
}

// Which repo a checkout is: its origin as "host/owner/name" in lower case (the folder when it has no origin).
function repoKey(dir) {
  const r = spawnSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
  let raw = (r.stdout || '').trim();
  const ssh = raw.match(/^(?:ssh:\/\/)?[\w.-]+@([^:/]+)[:/](.+)$/);
  if (ssh) raw = `https://${ssh[1]}/${ssh[2]}`;
  try { const u = new URL(raw); return `${u.host}${u.pathname}`.toLowerCase().replace(/\/+$/, '').replace(/\.git$/, ''); } catch { return dir; }
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function merge(file, values) {
  const current = readJson(file);
  if (!current || Object.entries(values).every(([k, v]) => current[k] === v)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...current, ...values }, null, 2) + '\n');
  return true;
}

function sync() {
  const all = checkouts();
  const dirs = all.filter((d) => fs.existsSync(path.join(d, '.claude', 'memory')));
  for (const dir of dirs) {
    const memory = path.join(dir, '.claude', 'memory');
    if (merge(path.join(dir, '.claude', 'settings.local.json'), { autoMemoryDirectory: memory })) say(`auto memory in ${dir} is its .claude/memory/`);
    const exclude = path.join(dir, '.git', 'info', 'exclude');
    const lines = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!lines.split('\n').includes('.claude/settings.local.json')) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, `${lines && !lines.endsWith('\n') ? '\n' : ''}.claude/settings.local.json\n`);
    }
  }
  const repos = new Set(all.map(repoKey));
  try {
    if (repos.size === 1 && dirs.length) {
      if (merge(MANAGED, { autoMemoryDirectory: path.join(dirs[0], '.claude', 'memory') })) say(`machine-wide auto memory is ${dirs[0]}/.claude/memory`);
    } else if (repos.size > 1) {
      // Only a setting this template wrote (a memory folder on Paperclip's volume) is removed.
      const current = readJson(MANAGED);
      if (current && String(current.autoMemoryDirectory || '').startsWith(`${HOME}/`)) {
        delete current.autoMemoryDirectory;
        fs.writeFileSync(MANAGED, JSON.stringify(current, null, 2) + '\n');
        say(`${repos.size} repos are checked out: machine-wide auto memory removed (each checkout keeps its own in its settings.local.json)`);
      }
    }
  } catch (e) { say(`could not update ${MANAGED}: ${e.message}`); }
}

for (;;) {
  try { sync(); } catch (e) { say(`check failed: ${e.message}`); }
  await new Promise((r) => setTimeout(r, 60000));
}
