# AutoBackup Hub Dockerfile
FROM node:20-slim

# Install system utilities & Rclone CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    rclone \
    curl \
    ca-certificates \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package.json ./

# Install npm dependencies
RUN npm install --only=production

# Copy application source files
COPY server/ ./server/
COPY public/ ./public/

# Default persistent directories
RUN mkdir -p /config /backup_sources

ENV PORT=3000
ENV CONFIG_DIR=/config
ENV RCLONE_CONFIG=/config/rclone.conf

# Define persistent volume for configuration and database
VOLUME ["/config"]

EXPOSE 3000

CMD ["npm", "start"]
