# RelayX 自建授权服务器 —— 独立构建上下文（本目录为 docker build 上下文）。
#
#   docker build -t relayx/license-server:selfhosted apps/license-server
#   docker run -d -p 127.0.0.1:8899:8899 -v license_data:/data relayx/license-server:selfhosted
#
# 与参考部署（relayx-analysis/Dockerfile.license-server，Python 版）的差异：
#   - 基础镜像 node:24-slim（`node:sqlite` 在 Node 22+ 可用，Node 24 无需实验旗标）；
#   - 运行时用 tsx 直接执行 TypeScript 源码，没有单独的编译步骤；
#   - 依赖在本目录用 npm 安装（package.json 没有 workspace: 依赖），因此镜像构建
#     不依赖仓库根目录的 pnpm-lock.yaml，也不会触发 Prisma 等无关包的安装脚本。

FROM node:24-slim

WORKDIR /app

# 依赖先装，最大化层缓存。
COPY package.json ./
RUN npm install --no-audit --no-fund --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    LICENSE_HOST=0.0.0.0 \
    LICENSE_PORT=8899 \
    LICENSE_DB=/data/license.db \
    LICENSE_CONTENT_MODE=plain

VOLUME ["/data"]
EXPOSE 8899

# 容器内没有 curl，用 Node 自带的 fetch 做健康检查。
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8899/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts", "serve"]
