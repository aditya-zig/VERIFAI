# Tiny on-demand M4 sandbox. No model, engine, service or package installation
# at audit time. Base is API-independent and already cached on this laptop.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /repo
