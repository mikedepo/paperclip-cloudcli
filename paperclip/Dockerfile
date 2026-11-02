# The Paperclip service of the Paperclip (w/ CloudCLI) template on Railway.
# Paperclip's official image, unchanged, plus our start scripts. The image runs as root; start.sh sets two
# machine-wide settings, then hands over to the image's own entrypoint, which drops to the node user.
FROM ghcr.io/paperclipai/paperclip:2026.1023.0

COPY . /opt/paperclip-cloudcli/

# tini as PID 1, as in the official image (it reaps the wiring and the runs' processes).
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "/opt/paperclip-cloudcli/start.sh"]
CMD []
EXPOSE 3100
