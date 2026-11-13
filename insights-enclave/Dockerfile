# The insights enclave's image: one bundled file on a stock Node image pinned by digest. Nothing of Router's
# server is in it. Build from the repository root:
#
#   docker buildx build -f insights-enclave/Dockerfile --build-arg SOURCE_DATE_EPOCH=0 \
#     --provenance=false --sbom=false --output type=image,name=<name>,rewrite-timestamp=true,push=true .
#
# The bundle is made by `npm run bundle:insights-enclave` in server/, from the locked dependencies, so anyone
# can make it again from the same commit and compare its SHA-256 (printed at build time, and in the image as
# /app/insights-enclave.mjs.sha256). With the base image pinned and timestamps rewritten, the image digest
# should come out the same as well; that is checked in CI, not yet by a second builder.
FROM docker.io/library/node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS bundle
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src/insights-enclave-server.ts server/src/insights-enclave.ts server/src/insights-program.ts server/src/insights-spec.ts \
     server/src/insights-weekly.ts server/src/trace-envelope.ts server/src/author-records.ts ./src/
COPY server/scripts/bundle-insights-enclave.mjs ./scripts/
RUN node scripts/bundle-insights-enclave.mjs /out

FROM docker.io/library/node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
WORKDIR /app
ENV NODE_ENV=production
COPY --from=bundle /out/insights-enclave.mjs /out/insights-enclave.mjs.sha256 ./
EXPOSE 3100
CMD ["node", "insights-enclave.mjs"]
