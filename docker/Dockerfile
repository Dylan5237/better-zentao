FROM node:24-slim AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY web ./web
COPY skills ./skills
COPY templates ./templates
RUN pnpm run build && pnpm prune --prod

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web ./web
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/templates ./templates
RUN mkdir -p /var/lib/bzt /etc/bzt && chown -R node:node /var/lib/bzt /app
USER node
EXPOSE 17330
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:17330/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/adapters/cli/bzt.js", "serve"]
CMD ["--server-config", "/etc/bzt/server.json"]
