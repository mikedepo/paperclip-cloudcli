# Changelog

Each entry is an update Railway offers to existing deployments of the template. Updates are opt-in: nothing changes until you apply one, and your data is kept (see the README).

## 2026-11-06

- Manage your jobs from your own computer. Paperclip's MCP server is now on, so an assistant there (Claude Code, Codex and others) can list, create, change, pause and run your jobs with only your Paperclip address and a sign-in in your browser. For Claude Code: `claude mcp add --transport http paperclip <your Paperclip address>/mcp/paperclip`, then `/mcp` in Claude Code, choose paperclip and Authenticate. The setup page shows your exact command, and the manual has the steps for other assistants. The assistant works through a new "Scheduler" agent in Paperclip, which runs the same commands as Claude's jobs script in CloudCLI, with no AI and no cost.
- Jobs made in Paperclip's dashboard or by an assistant follow the same rules as Claude's: they don't overlap or catch up on missed runs, and the server records them in their repo's `.claude/jobs.json` within 5 minutes. The record is committed in your repo's clone in CloudCLI, as before, and waits while that clone is on another branch. Jobs you already made in the dashboard get these rules once, after the update; a policy you change in the dashboard later is kept.
- Paperclip 2026.1106.0 (from 2026.1023.0). The Runner moves to Paperclip's native runner, its new default for Claude, set up so Claude Code still loads your repo's own settings, skills and shared memory; its model, Claude sign-in, instructions and jobs are kept. Jobs reach GitHub as before. The Codex agent stays as it is. Paperclip now hides tasks created by agents and routines from its task lists unless you turn on "show agent-created tasks", and cleans regenerable files (such as `node_modules`) out of finished task workspaces after an hour. See [Paperclip's release notes](https://github.com/paperclipai/paperclip/releases/tag/v2026.1106.0).
- Paperclip's company is renamed "Jobs (routines: give tasks to the Scheduler agent)", so an assistant on your computer finds the Scheduler from its first look. Tasks keep their `JOB-n` numbers, and a name you gave the company yourself is kept.
- The log of a run shows what Claude did on Paperclip's native runner as on the old one: its messages, each command with the start of its output, and the result.
- Applying this update restarts Paperclip on the new version, which upgrades its database on the first start (a few minutes on a large run history).

## 2026-11-04

- Jobs can run with OpenAI's Codex instead of Claude, on your ChatGPT plan. It is optional: the setup page's new "Optional: Codex" card signs Codex in on your server with a one-time code (first turn on "Enable device code sign-in for Codex" in ChatGPT, Settings, Security and login) and adds a "Codex" agent in Paperclip. Then ask Claude to run a job with Codex. Claude's Runner stays the default, and your Runner and jobs are unchanged. Codex jobs reach GitHub as the Runner's do. A Codex job's own keys are named without KEY, SECRET or TOKEN, because Paperclip keeps such variables out of Codex's commands; Claude names them that way, and the jobs script warns otherwise.
- The same card can sign in Codex for CloudCLI's own chats and terminal, with a second code.
- When a job must reach an outside service (Telegram, Slack, email, an API), Claude first looks for what exists: Paperclip's own apps, connections and plugins, then plugins others published on npm and MCP servers in the official MCP registry (the jobs script's new `connectors` command lists them). It suggests one only after checking it fits, works on this Paperclip version, is kept up, and what it can reach. When nothing fits, Claude offers both ways: a quick call inside the job's skill, or a custom connector (a Paperclip plugin, or an MCP server connected in Paperclip's Apps), which it recommends when several jobs or repos will use the service, it needs per-project settings, or it should answer back. Claude builds a connector only once you agree.
- When a job needs a key, Claude now sends you to the right place: the agent's Harness / Runtime page in Paperclip, Environment variables, with the steps. The Secrets & variables page only lists them.
- Testing a job takes as long as the run: the jobs script's `run --wait` waits for the run to finish and prints its log.
- Claude can check a test run's pull requests without asking first: read-only GitHub commands (`gh pr diff`, `gh pr checks`, `gh repo view`, `gh run list`, `gh run view`, `gh auth status`) are approved, on existing servers too, at their next start.

## 2026-11-02 (4)

- A job's record also lists the names of the secrets its skill needs (never their values), so a new server knows what to set up. `restore` shows them, and the jobs script says when the agent running a job doesn't have one yet.
- Claude keeps each repo's record matching Paperclip on its own: it records changes made in Paperclip's dashboard when it next looks at your jobs.

## 2026-11-02 (3)

- Every job is recorded in its repo, in `.claude/jobs.json`: title, prompt, schedule, time zone and status. Creating, changing, pausing, resuming or archiving a job commits and pushes that file, so git keeps every job and the history of its changes.
- The scheduled-jobs skill's new `restore` recreates on a new server the jobs your repos record, and `sync` records changes made in Paperclip's dashboard. `list` says when a repo's record and Paperclip disagree.
- After this update, jobs made before it are recorded at their next change, or at once if you ask Claude to record your jobs.

## 2026-11-02 (2)

- Each service's start log links to this changelog, after the line with its commit.

## 2026-11-02

- First release from this repository. The template's Paperclip and CloudCLI services now build from it (before, the same scripts were packed into each service's start command), so later changes reach existing deployments as Railway update notices.
- Each service logs the commit it runs at start: `[paperclip-cloudcli] Paperclip service, code <commit>`.
