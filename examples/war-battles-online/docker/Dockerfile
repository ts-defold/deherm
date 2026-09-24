# Self-hosted War Battles server. Deno is pinned so the unstable QUIC surface
# cannot drift underneath a contributor's local deployment.
FROM denoland/deno:2.9.7

WORKDIR /srv/war-battles-online

# make-cert.sh intentionally uses the system OpenSSL implementation and xxd
# so the certificate bytes are identical to the contributor-host flow.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl xxd \
  && groupadd --gid 10001 war-battles \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin war-battles \
  && rm -rf /var/lib/apt/lists/*

COPY core ./core
COPY server ./server
COPY docker/entrypoint.sh ./docker/entrypoint.sh
COPY docker/init-volumes.sh ./docker/init-volumes.sh

RUN chmod +x ./server/make-cert.sh ./server/ensure-resume-key.sh ./docker/entrypoint.sh ./docker/init-volumes.sh \
  && mkdir -p ./server/certs ./server/state \
  && chown -R 10001:10001 /srv/war-battles-online

ENV WAR_BATTLES_HOSTNAME=0.0.0.0 \
    WAR_BATTLES_PORT=4433 \
    WAR_BATTLES_HEALTH_PORT=8080 \
    WAR_BATTLES_ROSTER=8 \
    WAR_BATTLES_BOT_SKILL=2

EXPOSE 4433/udp
EXPOSE 8080/tcp

HEALTHCHECK --interval=3s --timeout=2s --start-period=5s --retries=20 \
  CMD deno eval --allow-net="127.0.0.1:8080" "const r = await fetch('http://127.0.0.1:8080/readyz'); if (!r.ok) Deno.exit(1);"

USER 10001:10001
ENTRYPOINT ["./docker/entrypoint.sh"]
