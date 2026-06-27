# syntax=docker/dockerfile:1
# pendpost - agent-operated social ops with a human approval gate.
# Multi-stage: build the React dashboard, then run the zero-dependency server.

# ---- stage 1: build the dashboard ----
FROM node:20-slim AS build
WORKDIR /app/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

# ---- stage 2: runtime ----
FROM node:20-slim
# ffmpeg/ffprobe power cover extraction + media validation in LIVE mode; mock
# mode does not need them, but they keep the image fully capable.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
# overlay the built dashboard from the build stage
COPY --from=build /app/app/dist ./app/dist

# Bind 0.0.0.0 INSIDE the container only; docker-compose maps it back to the
# host's 127.0.0.1 so the host exposure stays loopback. No credentials -> mock.
ENV PENDPOST_HOST=0.0.0.0
ENV PENDPOST_PORT=8090
EXPOSE 8090
CMD ["node", "server.mjs"]
