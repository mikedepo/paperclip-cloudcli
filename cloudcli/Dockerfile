# The CloudCLI service of the Paperclip (w/ CloudCLI) template on Railway.
# Node's official image plus our start scripts. CloudCLI, Claude Code, Codex and the GitHub CLI are installed at the
# first start into the home folder's volume (/home/node), so they survive redeploys and updates.
FROM node:22-bookworm

COPY . /opt/paperclip-cloudcli/

# bash stays PID 1 (it reaps what terminals leave behind) and starts as root to prepare the volume; CloudCLI, the
# setup page and the wiring run as the node user.
ENTRYPOINT ["bash", "/opt/paperclip-cloudcli/start-bundle.sh"]
CMD []
EXPOSE 3001
