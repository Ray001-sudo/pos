# =============================================================================
# Admin Dashboard Dockerfile — Vite build + Nginx serve
# =============================================================================

# Stage 1: Build React app
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Nginx to serve static files
FROM nginx:1.25-alpine AS final

# Remove default Nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx config injected via volume in docker-compose
EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
