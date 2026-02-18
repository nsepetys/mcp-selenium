FROM node:18-slim

# Install Chrome, Firefox, dependencies, and tini for proper zombie process handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-driver \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm1 \
    libasound2 \
    tini \
    procps \
    curl \
    wget \
    ca-certificates \
    socat \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Set Chrome environment variables
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMEDRIVER_PATH=/usr/bin/chromedriver
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Pre-download Firefox and geckodriver via Selenium Manager during build
# This ensures they're cached and available at runtime (airlocked network can't download)
# Make accessible to all users (container may run as non-root)
RUN ./node_modules/selenium-webdriver/bin/linux/selenium-manager --browser firefox --output JSON && \
    chmod 755 /root && \
    chmod -R 755 /root/.cache

# Copy application code
COPY . .

# Make entrypoint script executable
RUN chmod +x docker-entrypoint.sh

# Expose port for HTTP/SSE mode
EXPOSE 3000

# Use tini as init to properly reap zombie processes
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]

# Default to stdio mode; use --http or --sse for HTTP transport
CMD []