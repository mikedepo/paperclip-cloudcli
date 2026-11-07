---
name: scheduled-jobs
description: List, create, change, pause, run and check this server's scheduled jobs (Paperclip routines run by the Runner agent with Claude, or by the Codex agent when the user chose Codex), and read what a run did and cost. Use whenever the user wants something to run on a schedule or now, asks when jobs run, why a job failed or what it cost, or wants a job's result sent somewhere (Telegram, Slack, email) or another service used in a job, even if they don't say "job".
---

# Scheduled jobs

Jobs run in Paperclip, on this server. A job is a schedule plus a one-line prompt naming a skill in one of the user's repos. When it fires, Paperclip opens a task for the Runner agent, which pulls that repo, runs that skill and closes the task. The job's logic lives in the skill, in git; the job only says when and which.

Script (prints text; `--json` for the raw API objects):

```
node ~/.claude/skills/scheduled-jobs/jobs.mjs repos                                           # the connected repos
node ~/.claude/skills/scheduled-jobs/jobs.mjs list                                            # each job's repo too
node ~/.claude/skills/scheduled-jobs/jobs.mjs create "Daily report" --prompt "Run the daily-report skill." --cron "0 9 * * 1-5"   # server zone; --tz to override; --repo <name>
node ~/.claude/skills/scheduled-jobs/jobs.mjs update "Daily report" --cron "30 8 * * 1-5"      # also --title, --prompt, --tz, --repo (moves it), --agent
node ~/.claude/skills/scheduled-jobs/jobs.mjs pause|resume|archive "Daily report"
node ~/.claude/skills/scheduled-jobs/jobs.mjs run "Daily report" --wait                       # run now, wait for it, print its log
node ~/.claude/skills/scheduled-jobs/jobs.mjs runs "Daily report" --limit 5
node ~/.claude/skills/scheduled-jobs/jobs.mjs log "Daily report" [--run 2] [--full]          # task status, summary, tokens, cost, log
node ~/.claude/skills/scheduled-jobs/jobs.mjs sync                                            # record now what the server records within 5 minutes
node ~/.claude/skills/scheduled-jobs/jobs.mjs restore [--yes]                                 # recreate recorded jobs Paperclip doesn't have
```

A job is named by its title (any case) or the start of its ID.

## Conventions

- **A job belongs to one repo, the repo of this chat.** Each connected repo (listed in `~/.claude/CLAUDE.md`) has its own project in Paperclip, and the Runner runs a job on Paperclip's own checkout of the job's repo. Write the skill in the repo this chat is in and run the script from there: `create` reads the current folder's git remote. `--repo <name or owner/name>` names another connected repo. When the folder isn't in a connected repo, the script stops and lists the connected ones: ask the user which repo the job is for (or to add theirs on CloudCLI's `/setup` page, step 3), then pass `--repo`.
- **Every job is recorded in its repo.** `create`, `update`, `pause`, `resume` and `archive` write the job (title, prompt, schedule, time zone, status, the names of the secrets it needs) into the repo's `.claude/jobs.json`, then commit and push that file alone: git keeps every job and the history of its changes, and the jobs can be rebuilt from it on a new server. Pass on the script's "Recorded in" line; when it says not committed or not pushed, fix that (usually a pull) and push. Change jobs with the script, not by editing the file.
- **Jobs made elsewhere are recorded by the server.** A job made or changed in Paperclip's dashboard, or by an assistant on the user's computer through Paperclip's MCP server (it gives Paperclip's "Scheduler" agent these same commands), gets no overlap and no backlog and is committed to its repo's record within 5 minutes; you don't need `sync` for that. Run `list` before changing jobs. When it still shows jobs "not recorded as they are now" (the clone is on another branch, or the change is a few minutes old), run `sync` and say so. Jobs only in a record (a new server, or a repo used on another one) → tell the user, run `restore` to show what it would recreate, and `restore --yes` once they agree.
- **Secrets a job needs:** when its skill uses a key or variable (an API key, a webhook address), pass the names with `--secrets "NAME,NAME"` on `create` (or `update`; `--secrets ""` clears them). The record keeps the names, never the values, so a new server knows what to set up, and the script says when the job's agent doesn't have one, with the steps and the link to give the user: the agent's **Harness / Runtime** page in Paperclip, Environment variables (its Secrets & variables page only lists them). Never ask for a value in the chat, and never write one into the repo.
- **Which agent runs a job: the Runner (Claude) unless the user asks for Codex.** When the user wants a job run with OpenAI's Codex (or "ChatGPT", "GPT", "OpenAI"), pass `--agent Codex` on `create`, or move an existing job with `update <job> --agent Codex` (`--agent Runner` moves it back). Codex needs the user's ChatGPT account connected in the "Optional: Codex" card of CloudCLI's `/setup` page; without it the script stops and says so: send the user there, never ask for an OpenAI key in the chat. Codex reads the same skill, `.claude/skills/<name>/SKILL.md` in the repo, so write it as plain steps either agent can follow. Paperclip keeps variables whose names contain KEY, SECRET or TOKEN out of Codex's commands, so a Codex job's secrets are named without those words (`TELEGRAM_BOT`, not `TELEGRAM_BOT_TOKEN`); the script warns when one isn't. GitHub works for Codex as for the Runner. The record keeps the agent (`"agent": "Codex"`). Then test with `run` as usual; `log` shows Codex's messages and commands, and its usage counts against the user's ChatGPT plan.
- **Outside services:** when a job must reach a service outside its repo (send its result to Telegram, Slack or email, read messages, call an API), read `~/.claude/skills/scheduled-jobs/connectors.md` before choosing how. It says how to find what already exists, and when to suggest a custom connector instead of a call in the skill.
- **One job, one skill.** The prompt is "Run the `<name>` skill." plus at most one line of arguments. Write or fix the skill in the repo, then commit and push it before the job runs: the Runner pulls first and runs what is pushed.
- **A job closes its own task in the same run.** The Runner's instructions say so; a skill written for a job should end with "mark the task done with a one-line summary, or blocked with the reason". A run that leaves its task open makes Paperclip start a second, costlier run just to close it.
- **No overlap, no backlog.** The script creates jobs with `skip_if_active` (a run that fires while the last one is still working is skipped) and `skip_missed` (runs missed while the server was down are dropped).
- **Test before trusting the schedule:** after creating or changing a job, `run <job> --wait`, with a 10-minute timeout on the command: it waits for the run to finish (up to 9 minutes), then prints its log. Don't write your own polling loop. To check what a run did (its pull requests, commits), use the read-only `git` and `gh` commands as plain commands, one per call or chained with `;` or `&&`: they are approved in advance, but a loop or a `$(...)` around them makes the user approve it.
- **Cost:** `log` shows each agent run's tokens and cost. Runs on a Claude subscription show no API cost; look at tokens.
- **Schedules** are 5-field cron in the job's time zone. New jobs use the server's zone (`TZ` on the deploy form, in `~/.claude/CLAUDE.md`; the script shows times in it) unless the user names another; pass it with `--tz` (an IANA name such as `America/Toronto`).
- **Give the user links:** the script prints each job's, task's and run's page in Paperclip's dashboard (same login as CloudCLI), where people see every job, its next run and each run's transcript.
- Don't create agents, companies or projects, and don't change the Runner's, Codex's or the Scheduler's setup: the template manages them and rewrites them at every start. Repos are added on the `/setup` page, which gives each its project.
