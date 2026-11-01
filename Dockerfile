# FlipDesk production image
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && npm i --no-save tsx

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    FLIPDESK_DB=/data/flipdesk.db \
    FLIPDESK_UPLOADS=/data/uploads
COPY --from=build /app /app
# Your database + photos live on a persistent volume mounted at /data.
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "--disable-warning=ExperimentalWarning", "server/index.ts"]
