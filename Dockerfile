# Stage 1: Get NATS Server binary with JetStream support
FROM nats:2.10-alpine AS nats-bin

# Stage 2: Build Frontend (React + Three.js + Vite)
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 3: Build Backend (Express + TypeScript)
FROM node:22-alpine AS backend-builder
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Stage 4: Unified Production Runtime (NATS + Backend + Static Frontend + pg-mem fallback)
FROM node:22-alpine AS runner
WORKDIR /app

# Copy NATS Server binary from Stage 1
COPY --from=nats-bin /usr/local/bin/nats-server /usr/local/bin/nats-server

# Install production dependencies for Backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

# Copy compiled Backend and SQL schema/seed script
COPY --from=backend-builder /app/backend/dist ./dist
COPY backend/src/db/init.sql ./src/db/init.sql

# Copy compiled Frontend static bundle where backend/dist/index.js expects it (../../frontend/dist)
WORKDIR /app
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

ENV NODE_ENV=production
ENV PORT=8080
ENV NATS_URL=nats://127.0.0.1:4222

EXPOSE 8080

# Start NATS JetStream in the background and launch the unified Express server
CMD ["sh", "-c", "nats-server -js -m 8222 -sd /tmp/nats-data & sleep 1 && node backend/dist/index.js"]
