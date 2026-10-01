FROM node:22.20.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin verifiai

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY services ./services
COPY scripts/cloud-worker.mjs ./scripts/cloud-worker.mjs

RUN chown -R verifiai:verifiai /app

USER 10001:10001

ENV NODE_ENV=production
ENV HOME=/home/verifiai

ENTRYPOINT ["node", "scripts/cloud-worker.mjs"]
