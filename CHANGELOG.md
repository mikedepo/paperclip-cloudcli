# Changelog

Each entry is an update Railway offers to existing deployments of the template. Updates are opt-in: nothing changes until you apply one, and your data is kept (see the README).

## 2026-11-02 (5)

- Jobs can run with OpenAI's Codex instead of Claude, on your ChatGPT plan. It is optional: the setup page's new "Optional: Codex" card signs Codex in on your server with a one-time code (turn on device code sign-in in ChatGPT's Security settings first) and adds a "Codex" agent in Paperclip. Then ask Claude to run a job with Codex. Claude's Runner stays the default, and your Runner and jobs are unchanged.
- The same card can sign in Codex for CloudCLI's own chats and terminal, with a second code.
- When a job must reach an outside service (Telegram, Slack, email, an API), Claude first looks for what exists: Paperclip's own apps, connections and plugins, then plugins others published on npm and MCP servers in the official MCP registry (the jobs script's new `connectors` command lists them). It suggests one only after checking it fits, works on this Paperclip version, is kept up, and what it can reach. When nothing fits, Claude offers both ways: a quick call inside the job's skill, or a custom connector (a Paperclip plugin, or an MCP server connected in Paperclip's Apps), which it recommends when several jobs or repos will use the service, it needs per-project settings, or it should answer back. Claude builds a connector only once you agree.

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
