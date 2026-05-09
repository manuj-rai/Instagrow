# Production image for ig-unfollower. Includes Chrome so the container can
# run Selenium without an external browser. For local dev on Windows you
# almost certainly want to use run.bat instead (faster, reuses your login).

FROM node:20-slim AS base

# Install Chrome + the system libs Chromium needs to run headless on slim.
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better Docker layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app code (src/, public/, etc.). dockerignore should exclude
# node_modules, data, .env from the build context.
COPY . .

# Create a snapshot directory the runtime can write to. Mark it as a volume
# so it persists across container restarts.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Run as non-root for safety.
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

# In a container the backend launches its own Chrome (no remote debugging).
ENV USE_REMOTE_DEBUGGING=false \
    NODE_ENV=production \
    PORT=4545

EXPOSE 4545

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:4545/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "src/server.js"]
