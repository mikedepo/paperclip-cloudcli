# Outside services for jobs

Read this when a job must reach a service outside its repo: send its result to a chat or an inbox, read messages, call a third-party API. Jobs run in Paperclip, on the other Railway service, as the Runner agent (or Codex). Claude Code's own MCP servers and plugins in this chat don't reach them.

## 1. Look for what exists: Paperclip's own, then what others published

```
node ~/.claude/skills/scheduled-jobs/jobs.mjs connectors telegram   # a service's name, or a word like mail or communication; nothing: Paperclip's whole catalog
```

It lists, with links:
- Paperclip's apps for that service (its built-in catalog: about 70 apps on Paperclip 2026.1023.0);
- the connections set up on this server;
- the installed plugins (none by default);
- given a service's name, the Paperclip plugins others published on npm, and the MCP servers in the official MCP registry.

For plugins on GitHub that aren't on npm, also run `gh search repos "paperclip plugin <service>"`. Tell the user what you found.

**Paperclip's own** come first:

- **An app with "tools for agents"** (Slack, Resend, Gmail, Notion, Linear, Zapier, Make and others): use it. The user connects it on Paperclip's Apps page and allows the job's agent to use it. Paperclip keeps the credential, passes the allowed tools to each run, and asks a person before risky actions. The job's skill names the tools to use.
- **Slack and email:** Paperclip's own `slack` and `agentmail` skills come with those apps. An agent gets them when a Slack bot or an AgentMail inbox is assigned to it, and a job's skill can then post to a channel or send an email.
- **A "channel" app** (Telegram, Discord, Teams, Slack's bot, AgentMail): people message one Paperclip agent there and it answers there. That covers two-way use, but it doesn't post a job's output on its own.
- **An installed plugin with tools for the service:** the job's skill calls its tool (see "A Paperclip plugin" below).

**What others published** is a lead, not a recommendation. Check it before suggesting it, and tell the user what you checked:
- **Fit:** read its README and its tools; does it do what this job needs?
- **Our Paperclip version (2026.1023.0):** when its last release came out, and its open issues about recent Paperclip versions.
- **Upkeep:** recent releases, answered issues, a license that allows use. A fork that carries a fix can be the better pick, if someone keeps it up.
- **What it can reach:**
  - a plugin runs inside Paperclip with Paperclip's own access, and its manifest's `capabilities` list what it asks for (Paperclip shows them at install);
  - a bot that takes commands should limit who may send them;
  - a hosted MCP server receives everything the job sends it, on someone else's servers.

Example, as of 2026-11-02: `paperclip-plugin-telegram` (MIT, about 100 stars) is two-way.
- It posts a notice when a task is done, with the first 300 characters of the job's summary, but it has no tool for a job to send its own text. It can announce a digest but not deliver one.
- Its latest release, 0.8.1, fails to save its bot token on Paperclip 2026.831 and later (its issue #112). The fix is an unmerged pull request.

Then recommend one of these:
- use it as is;
- use it and fill the gap: a pull request upstream, or a fork in the user's GitHub until the pull request is merged;
- build our own, when nothing fits or nothing can be trusted.

Installing someone else's code is the user's call, like building our own.

## 2. Nothing fits: say both options, and which you recommend

- **An inline call in the job's skill:** `curl` to the service's API, with its key and settings as secrets on the job's agent (`--secrets`). It's quick and fine for a one-off job. Its limits:
  - each job that needs the service repeats the call;
  - every repo's jobs run as the same Runner agent, so a secret bound on it is readable by every job on the server. A name per project (`TELEGRAM_CHAT_ID_ACME`) keeps settings apart, but not access;
  - nothing comes back from the service.
- **A custom connector:** recommend it when any of these holds:
  - the service will likely serve several jobs or repos;
  - it needs per-project settings (a chat, a channel or an account per repo);
  - its credential should stay out of the jobs;
  - two-way use would help (replies, or commands back to a job).

When one of those holds, suggest the connector yourself; don't wait to be asked. Build it only once the user agrees. Until then, the inline call can deliver: present it as a stopgap, and replace it in the skill once the connector is in.

Example: a daily digest sent to Telegram.
- Paperclip's Telegram app is a channel only, and the community plugin above announces tasks but can't send a job's text.
- So offer the Bot API's `sendMessage` in the skill now, with the bot token and chat ID as secrets.
- Then propose a connector if other jobs or repos will post to Telegram, each repo has its own chat, or the user wants to answer the bot. Either add a send tool (and the version fix) to that plugin, or build a small one of our own that asks for less.

## 3. Building a connector on this server

Keep it in git like the rest: the connector's code in a repo (a repo of its own when several repos use it), and in each job's skill, a line naming the connector and the settings it needs, so a new server knows what to set up.

### A Paperclip plugin: the most native kind

A plugin is code that runs inside Paperclip. It can:
- **give jobs tools.** A job calls them with its run's project, so the plugin picks that project's settings and keeps the credential to itself;
- **act on Paperclip's events**, such as posting a job's summary when its task is marked done, with no agent turn spent;
- **receive webhooks** at `<Paperclip's address>/api/plugins/<plugin id>/webhooks/<key>`, for messages coming back. A Telegram bot has one webhook, so use a separate bot from the one in Paperclip's Telegram channel;
- **keep its settings** and secret references in Paperclip, with its own settings page.

Build it:
- Use Paperclip's scaffold, `npx paperclipai plugin init @scope/name --template connector`, and follow the guide for our version: https://github.com/paperclipai/paperclip/blob/v2026.1023.0/doc/plugins/PLUGIN_AUTHORING_GUIDE.md.
- Check it with `pnpm typecheck`, `pnpm test` and `pnpm build`.
- Publish it as an npm package. The code holds no keys; they stay in Paperclip. Publishing needs the user's npm login, which they type themselves in CloudCLI's terminal.

Install it: the user installs the package on Paperclip's plugins page (the `connectors` command prints its link). There they review what the plugin asks to do, then enter its settings and keys. Paperclip installs plugins into its own data folder on its volume, so they survive restarts and template updates.

A plugin runs with Paperclip's own access to the server. Install only code the user wrote or reviewed.

A job's skill calls a plugin tool with `POST $PAPERCLIP_API_URL/api/plugins/tools/execute`. It authenticates with the run's own token (`Authorization: Bearer $PAPERCLIP_API_KEY`, given to every run). The body is `{ "tool": "<plugin key>:<tool>", "parameters": {...}, "runContext": { "agentId", "runId", "companyId", "projectId" } }`:
- the first three are in `$PAPERCLIP_AGENT_ID`, `$PAPERCLIP_RUN_ID` and `$PAPERCLIP_COMPANY_ID`;
- the project's ID is on the task: `GET /api/issues/$PAPERCLIP_TASK_ID`;
- some setups set `PAPERCLIP_API_URL` with `/api` at its end already, so don't double it.

This call is not tried on this template yet. Test the first job with `run`, then `log`. Paperclip may ask a person to allow the tool for the agent.

### An MCP server, connected in Paperclip's Apps

Use this when the service already has an MCP server (the vendor's, or a maintained open-source one) and jobs only need to call it:

- **A remote server** (an HTTPS address): Paperclip's Apps page, "Connect your own MCP server" (the `connectors` command prints the link), or "Paste a config" for an `mcpServers` snippet. Paperclip asks for the keys and keeps them as its secrets. It lists the server's actions for review (new ones start off), and the user allows it for the job's agent (the Runner, and Codex if it runs the job).
- **A command run locally** (stdio): "Advanced → Run your own", a higher-trust path. The command runs on Paperclip's service, whose image is replaced at each update while only its volume is kept. So use a command that fetches its package each time (`npx -y <package>`).
- **An MCP server we write ourselves:** host it with an HTTPS address (its own Railway service, for instance) and connect it as a remote server.

The user does the connecting in Paperclip, since they type the keys. You give them the steps and the exact config.

## 4. What survives restarts and updates

- Apps, connections and plugins are Paperclip's own records, in its database and on its volume, and the template doesn't touch them. At each start it rewrites only these, on the Runner (and Codex):
  - its instructions;
  - its working folder, when the first repo changes;
  - its Claude and GitHub secret bindings. Other bindings are kept.
- Never give the Runner an MCP server any other way: no `.mcp.json` in the repo, no `claude mcp add` on Paperclip's service, no `--mcp-config` in its settings. Once any app is allowed for the agent, Paperclip starts Claude with `--strict-mcp-config` and its own server list, and those servers stop loading without an error.
