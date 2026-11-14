![Paperclip + CloudCLI: scheduled agent jobs and Claude Code in your browser](https://cdn.jsdelivr.net/gh/mikedepo/railway-template-assets@9fe61a7/paperclip-cloudcli/banner.png)

# Paperclip (w/ CloudCLI) for Railway

**[User manual](https://docs-production-3003.up.railway.app)**: setup, your first job, jobs in git, updates and troubleshooting, with screenshots.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/paperclip-w-cloudcli)

Claude on a schedule, with every run on record. Connect a GitHub repo and tell Claude in plain words what should happen and when. Claude writes the job's instructions into your repo, schedules the job in [Paperclip](https://github.com/paperclipai/paperclip) and tests it once. From then on Paperclip runs it on time, and you keep Claude Code in any browser or phone through [CloudCLI](https://cloudcli.ai).

![Ask Claude for a job in plain words, Paperclip runs it on schedule, and every run keeps its result](https://cdn.jsdelivr.net/gh/mikedepo/railway-template-assets@b1afff6/paperclip-cloudcli/readme-featured.png)

## Why it's different

- **Your jobs live in your repo.** A job's instructions are a skill file, and its schedule an entry in `.claude/jobs.json`. Every change is a commit, and a new server recreates the jobs from them.
- **Every run is on record:** its status, result, full transcript, model and tokens, on Paperclip's dashboard.
- **Your own Claude subscription.** Pro or Max signs in through Claude Code's official sign-in, and the token stays on your server. Codex on your ChatGPT plan is optional.
- **Easy to start.** An email and a password to deploy, then one setup page to connect Claude and GitHub, add repos, and, if you like, put both apps on your own domains.
- **Reachable from your computer too.** Claude Code or Codex on your laptop can list, create and change your jobs through Paperclip's MCP server.

## What runs on your server

![Architecture: CloudCLI and Paperclip in your Railway project, with Postgres and a volume, your Claude account and your GitHub repo](https://cdn.jsdelivr.net/gh/mikedepo/railway-template-assets@9fe61a7/paperclip-cloudcli/architecture.png)

Railway builds each service from its folder's `Dockerfile` in this repository. You don't need to clone it: deploy the template instead.

| Folder | Service | What it adds |
| --- | --- | --- |
| [`paperclip/`](paperclip/) | Paperclip | Paperclip's official image (`2026.1106.0`) plus our start: the first admin from the deploy form, the Runner agent for your jobs, your repos and shared Claude memory. |
| [`cloudcli/`](cloudcli/) | CloudCLI | Node's official image plus our start: CloudCLI, Claude Code, Codex and the GitHub CLI on a volume, the `/setup` page, and the `scheduled-jobs` skill that lets Claude manage your jobs. |

The template adds a private Postgres database for Paperclip.

## Updates

When this repository changes, Railway shows **Update available** on your project. Updates are opt-in and keep your data and variables: read the [CHANGELOG](CHANGELOG.md), then apply the update to Paperclip, then to CloudCLI. The manual's [Updates](https://docs-production-3003.up.railway.app/maintenance/updates/) page has the details.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Source-available, not open source: you may read this code and run it, as is or modified, as part of a deployment of the template on Railway. See [LICENSE](LICENSE).

Third-party software keeps its own license, and none of it is copied into this repository: **Paperclip** (MIT, its official image, unchanged), **CloudCLI** (AGPL-3.0, [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui), installed from npm at the first start and run unmodified; our setup page sits in front of it and passes its traffic through), **Claude Code** (Anthropic's terms), **Codex** (Apache-2.0) and the **GitHub CLI** (MIT), downloaded from their publishers at the first start.
