# API GreenCanteen (thư mục server/). Dùng cho Fly.io (fly.toml), hoặc Railway khi để trống Root Directory. Giao diện (client/) triển khai riêng.
# Mô hình nhận diện ảnh không nằm trong image (git và .dockerignore bỏ server/models): đặt trên volume, VISION_MODEL_DIR trỏ tới đó.
# Node 24: bản đã đo trên máy hiệu chỉnh mô hình. Debian (glibc), không dùng Alpine: onnxruntime-node không có bản cho musl.
FROM node:24-bookworm-slim

# PORT: Railway tự đặt và ghi đè giá trị này; Fly dùng 8080 (internal_port trong fly.toml).
# ONNXRUNTIME_NODE_INSTALL=skip: không tải thêm thư viện CUDA khi cài, server chỉ chạy CPU (gói npm có sẵn bản CPU cho Linux x64).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
# Lệnh chạy trong container: npm run vision:download / vision:verify / vision:selfcheck (fly ssh console, railway ssh)
COPY server/scripts ./scripts

EXPOSE 8080

# Chạy node trực tiếp, không qua npm, để tiến trình nhận SIGTERM khi nền tảng dừng hoặc thay máy
CMD ["node", "src/index.js"]
