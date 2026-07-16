FROM --platform=linux/arm64 node:22-slim AS build

WORKDIR /app
COPY app/tmms_ui/package.json app/tmms_ui/package-lock.json ./
RUN npm ci
COPY app/tmms_ui/ ./
RUN npm run build

FROM --platform=linux/arm64 node:22-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/tmms_venv \
    && /opt/tmms_venv/bin/pip install --no-cache-dir mcap mcap-ros2-support

ENV TMMS_PYTHON_BIN=/opt/tmms_venv/bin/python3
ENV TMMS_BAGS_DIR=/home/htxgrrt/.htxgrrt/bags/rosbags

COPY app/tmms_ui/package.json app/tmms_ui/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY app/tmms_ui/ui_backend.js ./
COPY app/tmms_ui/scripts ./scripts

EXPOSE 3001
CMD ["node", "ui_backend.js"]
