---
name: scheduled-jobs
description: List, create, change, pause, run and check this server's scheduled jobs (Paperclip routines run by the Runner agent), and read what a run did and cost. Use whenever the user wants something to run on a schedule or now, asks when jobs run, why a job failed or what it cost, even if they don't say "job".
---

# Scheduled jobs

Jobs run in Paperclip, on this server. A job is a schedule plus a one-line prompt naming a skill in one of the user's repos. When it fires, Paperclip opens a task for the Runner agent, which pulls that repo, runs that skill and closes the task. The job's logic lives in the skill, in git; the job only says when and which.

Script (prints text; `--json` for the raw API objects):

```
node ~/.claude/skills/scheduled-jobs/jobs.mjs list                                            # each job's repo too
node ~/.claude/skills/scheduled-jobs/jobs.mjs create "Daily report" --prompt "Run the daily-report skill." --cron "0 9 * * 1-5"   # server zone; --tz to override; --repo <name>
node ~/.claude/skills/scheduled-jobs/jobs.mjs update "Daily report" --cron "30 8 * * 1-5"      # also --title, --prompt, --tz, --repo (moves it)
node ~/.claude/skills/scheduled-jobs/jobs.mjs pause|resume|archive "Daily report"
node ~/.claude/skills/scheduled-jobs/jobs.mjs run "Daily report"                              # run now
node ~/.claude/skills/scheduled-jobs/jobs.mjs runs "Daily report" --limit 5
node ~/.claude/skills/scheduled-jobs/jobs.mjs log "Daily report" [--run 2] [--full]          # task status, summary, tokens, cost, log
```

A job is named by its title (any case) or the start of its ID.

## Conventions

- **A job belongs to one repo, the repo of this chat.** Each connected repo (listed in `~/.claude/CLAUDE.md`) has its own project in Paperclip, and the Runner runs a job on Paperclip's own checkout of the job's repo. Write the skill in the repo this chat is in and run the script from there: `create` reads the current folder's git remote. `--repo <name or owner/name>` names another connected repo. When the folder isn't in a connected repo, the script stops and lists the connected ones: ask the user which repo the job is for (or to add theirs on CloudCLI's `/setup` page, step 3), then pass `--repo`.
- **One job, one skill.** The prompt is "Run the `<name>` skill." plus at most one line of arguments. Write or fix the skill in the repo, then commit and push it before the job runs: the Runner pulls first and runs what is pushed.
- **A job closes its own task in the same run.** The Runner's instructions say so; a skill written for a job should end with "mark the task done with a one-line summary, or blocked with the reason". A run that leaves its task open makes Paperclip start a second, costlier run just to close it.
- **No overlap, no backlog.** The script creates jobs with `skip_if_active` (a run that fires while the last one is still working is skipped) and `skip_missed` (runs missed while the server was down are dropped).
- **Test before trusting the schedule:** after creating or changing a job, `run` it, wait for it to finish, then `log` it.
- **Cost:** `log` shows each agent run's tokens and cost. Runs on a Claude subscription show no API cost; look at tokens.
- **Schedules** are 5-field cron in the job's time zone. New jobs use the server's zone (`TZ` on the deploy form, in `~/.claude/CLAUDE.md`; the script shows times in it) unless the user names another; pass it with `--tz` (an IANA name such as `America/Toronto`).
- **Give the user links:** the script prints each job's, task's and run's page in Paperclip's dashboard (same login as CloudCLI), where people see every job, its next run and each run's transcript.
- Don't create agents, companies or projects, and don't change the Runner's instructions: the template manages them and rewrites them at every start. Repos are added on the `/setup` page, which gives each its project.
