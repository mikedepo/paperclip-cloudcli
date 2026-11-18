# Changelog

Each entry is an update Railway offers to existing deployments of the template. Updates are opt-in: nothing changes until you apply one, and your data is kept (see the README).

## Unreleased

- Claude, Codex, or both: use OpenAI's Codex on your ChatGPT plan instead of Claude, or alongside it, for the agent that runs jobs. Step 1 of the setup page is now "Claude, Codex, or both", and either one finishes setup. The "Optional: Codex" card moved into it, with the same one-time code for Paperclip's Codex agent.
- New jobs go to the Runner (Claude) when Claude is connected, and to Codex when only Codex is. With both, ask for Codex to use it, as before.
- Codex chats in CloudCLI, off unless you turn them on. Codex's sandbox can't start on Railway, so Codex chats work only in CloudCLI's Bypass Permissions mode, where Codex runs commands and edits files without asking first. Step 1 says so, and turns them on once you tick the box: they take a second one-time code (one ChatGPT sign-in can't serve both Paperclip and CloudCLI), then the page selects Bypass Permissions for Codex in your browser. Turn off signs Codex out of CloudCLI again. Codex chats need ChatGPT Plus or higher; Codex jobs also run on a free plan. Claude chats are unchanged and still ask.
- Codex chats know the server as Claude does: the template writes the same instructions to `~/.codex/AGENTS.md` and links the scheduled-jobs skill where Codex finds it, so Codex can create, change, test and record jobs. Codex is told to ask you in the chat before anything destructive.
- If you already signed Codex in for CloudCLI with the 2026-11-04 card, Codex chats count as off until you turn them on: in CloudCLI's default mode they can't run commands.

## 2026-11-14 (4)

- Your password no longer has to stay in Railway. Both apps need `ADMIN_PASSWORD` only at their first start, to create your account, and keep just a hash of it. Once setup is done, you can delete it from the Paperclip service's variables, or seal it there (Railway then hides its value for good), and sign in as before. To change your password later, set `ADMIN_PASSWORD` again and redeploy Paperclip, then CloudCLI, as before. The setup page says so once setup is finished.
- On an existing server: apply this update with `ADMIN_PASSWORD` still set, and remove it only after Paperclip has started once on the update. That start creates the key the template uses from then on instead of your password.
- Paperclip's start no longer passes your password to the template's own setup through its environment, where processes of the same user could read it for a moment at each start.

## 2026-11-14 (3)

- README only, nothing to apply.

## 2026-11-14 (2)

- Put CloudCLI and Paperclip on domains of your own, such as `cloudcli.example.com`. The setup page's new "Optional: your own domains" card gives the Railway steps for each app with the right port, then checks the DNS record and HTTPS and says what is still missing. A CloudCLI domain is used as soon as it works; Paperclip takes its new domain at its next start (redeploy it in Railway once the DNS record works). Nothing else to change: no variables to edit.
- Paperclip can no longer lock itself out. Its start always adds Railway's health check, its private address (CloudCLI's) and every public domain it has had to the hostnames it answers, whatever `PAPERCLIP_ALLOWED_HOSTNAMES` says. Your Railway addresses keep working next to your own domains, and an edit of that variable can't fail every deploy's health check any more.
- CloudCLI asks Paperclip for its public address, at its start and every 5 minutes, so the links Claude gives you, the MCP address and the setup page follow a new Paperclip domain without a redeploy of CloudCLI.
- Assistants connected from your computer with Paperclip's old address stop working once Paperclip uses a new one: add them again with the new address (the setup page shows the command).

## 2026-11-14

- Fixes scheduled jobs that never ran on servers deployed since the 2026-11-07 update: the Runner stayed paused because Paperclip's check of its native runner fails in Paperclip's Docker image ([paperclip#18557](https://github.com/paperclipai/paperclip/issues/18557)). The Runner now runs on the legacy adapter (the Claude Code CLI, as before 2026-11-07); a paused Runner is moved there at the next start and runs your jobs again. It moves to Paperclip's native runner by itself once a Paperclip version passes that check.

## 2026-11-07 (2)

- An assistant on your computer puts a job in the repo you name, or else in the repo of the folder it's working in, and stops to ask when that repo isn't connected to your server.

## 2026-11-07

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
