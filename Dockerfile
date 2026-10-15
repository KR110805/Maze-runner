# Multi-stage production Dockerfile for Google Cloud Run
FROM node:22-alpine AS production

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=8080

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

# Copy application assets and source files
COPY api/ ./api/
COPY audio.js ./
COPY config.js ./
COPY game.js ./
COPY host.html ./
COPY index.html ./
COPY login.html ./
COPY maze.js ./
COPY player.js ./
COPY qrcode.min.js ./
COPY server.js ./
COPY style.css ./
COPY sync.js ./
COPY three.min.js ./

# Run as non-root user for container security
USER node

# Expose default Cloud Run port
EXPOSE 8080

# Healthcheck to verify local HTTP response
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/host.html || exit 1

# Start production server
CMD ["node", "server.js"]
