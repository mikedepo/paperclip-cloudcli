# Changelog

Each entry is an update Railway offers to existing deployments of the template. Updates are opt-in: nothing changes until you apply one, and your data is kept (see the README).

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
