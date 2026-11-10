FROM node:22-alpine AS builder

WORKDIR /app/server

# Copy package files
COPY server/package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source and build
COPY server/src/ ./src/
COPY server/tsconfig.json ./
RUN npm run build

# Build Astro frontend (index route migration)
FROM node:22-alpine AS setup-builder
WORKDIR /app/browser
COPY browser/package*.json ./
RUN npm ci
COPY browser/ ./
RUN npm run build

FROM node:22-alpine AS web-builder

WORKDIR /app/web

COPY web/package.json ./
RUN npm install --no-audit --no-fund

COPY web/ ./
RUN npm run build

# Production image
FROM node:22-alpine

WORKDIR /app/server

# Copy package files and install production deps only
COPY server/package*.json ./
RUN npm ci --only=production

# Copy built files
COPY --from=builder /app/server/dist ./dist

# Copy legacy static files (except index, now built by Astro)
COPY prompt.html setup.html profile.html entry.html dashboard.html join.html settings.html connect.html release.html RELEASE_NOTES.md docs.html DOCS.md docs-overview.svg /app/
COPY posting-rules.html posting-rules.js sharing-notice.js safe-html.js /app/
# Pinned local copies of the markdown renderer and HTML sanitizer: pages load no third-party script.
COPY vendor/ /app/vendor/
COPY group-setup.html group-setup.css /app/
# The shared stylesheet, the icon and the self-hosted fonts every page uses.
COPY router.css favicon.svg verify-email.html unsubscribe.html /app/
COPY assets/ /app/assets/
COPY --from=setup-builder /app/onboarding-assets/ /app/onboarding-assets/

# Copy Astro-built index + static assets
COPY --from=web-builder /app/web/dist/index.html /app/index.html
COPY --from=web-builder /app/web/dist/styles /app/styles
COPY --from=web-builder /app/web/dist/scripts /app/scripts

# Ensure data volume mount point exists and is world-writable
# (volume mounts override permissions; TEE provides the security boundary)
RUN mkdir -p /data && chmod 777 /data

EXPOSE 3000

CMD ["node", "dist/http.js"]
