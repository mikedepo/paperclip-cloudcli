# Paperclip (w/ CloudCLI) for Railway

The code behind the Railway template **[Paperclip (w/ CloudCLI)](https://railway.com/deploy/paperclip-w-cloudcli)**: [Paperclip](https://github.com/paperclipai/paperclip) runs scheduled AI agent jobs and keeps every run, and [CloudCLI](https://cloudcli.ai) gives you Claude Code (and Codex) in any browser or phone. The two are wired together on one server: one login, your repos in both, and a `scheduled-jobs` skill so Claude can create and manage jobs for you.

To use it, deploy the template from the link above. You don't need to clone this repository.

## What's here

| Folder | Railway service | What it does |
| --- | --- | --- |
| [`paperclip/`](paperclip/) | Paperclip | Paperclip's official image (pinned to `2026.1023.0`) plus our start: the first admin from the deploy form, the company, project and Runner agent for your jobs, your repos, and the shared Claude memory. |
| [`cloudcli/`](cloudcli/) | CloudCLI | Node's official image plus our start: installs CloudCLI, Claude Code, Codex and the GitHub CLI into the home folder's volume at the first start, serves the `/setup` page, and connects the `scheduled-jobs` skill to Paperclip. |

The template adds a private Postgres database for Paperclip. Railway builds each service from its folder's `Dockerfile`.

## Updates

When we change this repository, Railway shows an **Update available** button on your project's canvas.

- **Updates are opt-in.** Nothing changes in your deployment until you apply one, and you can skip any.
- **Read the [CHANGELOG](CHANGELOG.md) first.** Each entry says what changed and anything you need to do.
- **To apply it:** press **Update available**, then **Yes**. It updates one service at a time, so press it again for the other one (Paperclip, then CloudCLI). Or open a service's **Settings**, find **Upstream Repo** under Source, press **Check for updates**, then **Update**. Each service rebuilds and restarts, which takes a few minutes.
- **Your data is kept.** An update replaces the services' code only. The volumes (Paperclip's data, CloudCLI's home folder with your sign-ins, sessions and repo clones, and the database with your jobs and runs) and your variables stay as they are.
- Each service logs the commit it runs at start (`[paperclip-cloudcli] Paperclip service, code <commit>`), so you can tell which version you have.

The tools CloudCLI installs keep their own update paths: CloudCLI's own Update button, and Claude Code and Codex update themselves. A newer CloudCLI you installed is kept.

## Issues and pull requests

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Source-available, not open source: you may read this code and run it, as is or modified, as part of a deployment of the template on Railway. See [LICENSE](LICENSE) for the terms.

Third-party software keeps its own license, and none of it is copied into this repository:
- **Paperclip** (MIT, [paperclipai/paperclip](https://github.com/paperclipai/paperclip)): its official image is the Paperclip service's base image, used unchanged.
- **CloudCLI** (AGPL-3.0, [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)): installed from npm (`@cloudcli-ai/cloudcli`) into your volume at the first start and run unmodified. Our setup page sits in front of it and passes its traffic through.
- **Claude Code** (Anthropic's terms), **Codex** (Apache-2.0) and the **GitHub CLI** (MIT) are downloaded from their publishers at the first start.
