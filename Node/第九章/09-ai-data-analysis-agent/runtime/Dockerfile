FROM node:22-bookworm-slim
WORKDIR /opt/runner
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY entry.mjs query-worker.js ./
USER node
ENTRYPOINT ["node", "/opt/runner/entry.mjs"]
