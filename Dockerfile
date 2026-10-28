# The pi-live relay. Node runs the TypeScript sources directly (type stripping).
FROM node:24.22.1-slim

ENV NODE_ENV=production \
    COLORTERM=truecolor \
    PI_LIVE_HTTP_PORT=8080 \
    PI_LIVE_SSH_PORT=2222 \
    PI_LIVE_HOST_KEY_FILE=/etc/pi-live/host_key

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY relay ./relay

USER node
EXPOSE 8080 2222
CMD ["node", "relay/main.ts"]
