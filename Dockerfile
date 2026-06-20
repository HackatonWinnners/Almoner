# Almoner dashboard + API. Runs the TypeScript server directly via tsx.
FROM node:22-slim

WORKDIR /app

# Install deps (incl. dev: tsx runs the TS server). NODE_ENV is set AFTER this so
# `npm ci` keeps devDependencies.
COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# Containerized deploys can't reach the local Circle CLI session → mock wallet.
ENV ALMONER_WALLET=mock

EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
