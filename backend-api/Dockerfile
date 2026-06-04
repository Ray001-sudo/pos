# =============================================================================
# Backend API Dockerfile — multi-stage, non-root, minimal attack surface
# =============================================================================

# Stage 1: dependency install
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Stage 2: final minimal image
FROM node:20-alpine AS final
WORKDIR /app

# Create non-root user
RUN addgroup -S posapi && adduser -S posapi -G posapi

# Copy dependencies and source
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=posapi:posapi src/ ./src/
COPY --chown=posapi:posapi package.json ./

# Create log directory
RUN mkdir -p logs && chown posapi:posapi logs

USER posapi

EXPOSE 3000

# Use node directly — no shell wrapper (no shell injection vector)
CMD ["node", "src/server.js"]
