# syntax=docker/dockerfile:1

FROM node:24-slim AS root-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM root-deps AS client-deps
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci

FROM client-deps AS build
COPY . .
RUN npm run build

FROM node:24-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM oven/bun:1-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173 \
    MEMORY_DIR=/app/data

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/client/dist ./client/dist
COPY package.json package-lock.json server.ts ./
COPY agent ./agent
COPY helpers ./helpers
COPY routes ./routes
COPY scripts ./scripts

RUN mkdir -p /app/data

EXPOSE 5173
CMD ["bun", "server.ts"]
