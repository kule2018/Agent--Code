FROM node:22-bookworm-slim
WORKDIR /opt/runner
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY entry.js query-worker.js ./
USER 1000:1000
ENTRYPOINT ["node", "/opt/runner/entry.js"]
