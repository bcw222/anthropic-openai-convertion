# Build arg so the base can be swapped where docker.io is unreachable, e.g.
#   podman build --build-arg NODE_IMAGE=registry.cn-hangzhou.aliyuncs.com/arm64m/node:24-alpine .
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

# Deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY node.mjs ./
COPY src ./src

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "node.mjs"]
