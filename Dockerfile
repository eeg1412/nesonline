FROM node:20-alpine

LABEL maintainer="eeg1412"
LABEL description="NES Online - Cloud NES gaming with tile-delta broadcast"

WORKDIR /app

# 只拷贝 package 文件，利用 Docker 层缓存
COPY package.json package-lock.json ./

# 生产依赖安装
RUN npm ci --omit=dev

# 拷贝源码
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/

# 创建运行时目录
RUN mkdir -p /data/snapshots /data/roms

# 非 root 用户运行
RUN addgroup -S nesuser && adduser -S nesuser -G nesuser
RUN chown -R nesuser:nesuser /app /data
USER nesuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV SNAPSHOT_DIR=/data/snapshots
ENV ROM_PATH=/data/roms/game.nes

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
