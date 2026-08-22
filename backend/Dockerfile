# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install all dependencies (including devDependencies needed for tsc)
COPY package*.json ./
RUN npm ci || npm install
RUN npm install

COPY . .
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy compiled output and migrations from the build stage
COPY --from=builder /app/dist ./dist

EXPOSE 3000 9090

USER node

CMD ["npm", "start"]
