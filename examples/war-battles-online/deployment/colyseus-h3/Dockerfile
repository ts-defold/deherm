# The current arm64 quiche prebuild requires glibc >= 2.38. Debian Trixie meets
# that requirement; Bookworm does not and fails at runtime with ERR_DLOPEN_FAILED.
FROM node:22-trixie-slim

WORKDIR /srv/war-battles-h3

# The current H3 dependency graph includes a Git dependency.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Keep this probe independent from the repository package graph. Versions are
# exact so a later Colyseus H3 change cannot silently turn a passing probe into
# a different experiment.
RUN npm init -y \
    && npm install --omit=dev --save-exact \
        @colyseus/h3-transport@0.18.2 \
        @colyseus/sdk@0.18.2 \
        colyseus@0.18.2 \
        express@5.2.1 \
    && npm cache clean --force

COPY server.mjs probe.html ./

ENV HOST=0.0.0.0
ENV PORT=2567
ENV PROBE_PORT=8080

EXPOSE 2567/tcp
EXPOSE 2567/udp
EXPOSE 8080/tcp

CMD ["node", "server.mjs"]
