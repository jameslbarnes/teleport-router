# Exactly the Hermes release already used by the Tulip Discord profile.
# The upstream v0.23.0 tag resolves to commit 2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19.
FROM nousresearch/hermes-agent:v0.23.0@sha256:adb7890916de63245523492be8f68f9d2095fecbec4e2a6dab7960381f0fc002

USER root
RUN /opt/hermes/.venv/bin/python -c "from pathlib import Path; assert '2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19' in Path('/opt/hermes/install-stamp.json').read_text(); import discord, anthropic; from mcp.server.mcpserver import MCPServer"
COPY discord-phala/entrypoint.py discord-phala/health.py discord-phala/cohort_archive.py discord-phala/discord_archive.py discord-phala/cohort_mcp.py discord-phala/config.yaml discord-phala/SOUL.md discord-phala/private.json discord-phala/participation.json /opt/router-discord/
COPY discord-test/router-private/ /opt/router-discord/plugins/router-private/
COPY discord-test/router-participation/ /opt/router-discord/plugins/router-participation/
RUN cp /opt/router-discord/private.json /opt/router-discord/plugins/router-private/settings.json && \
    cp /opt/router-discord/participation.json /opt/router-discord/plugins/router-participation/settings.local.json && \
    mkdir -p /data/hermes /data/workspace && chown -R 10000:10000 /data && \
    chmod -R go-w /opt/router-discord

ENV HERMES_HOME=/data/hermes \
    HOME=/data \
    COHORT_ARCHIVE=/data/cohort.json \
    HERMES_DISABLE_LAZY_INSTALLS=1 \
    DISCORD_ALLOWED_USERS="" \
    DISCORD_ALLOWED_ROLES="" \
    DISCORD_ALLOW_ALL_USERS=false \
    HERMES_ALLOW_ALL_USERS=false \
    PYTHONUNBUFFERED=1
USER 10000:10000
WORKDIR /data/workspace
ENTRYPOINT ["/opt/hermes/.venv/bin/python", "-I", "/opt/router-discord/entrypoint.py"]
