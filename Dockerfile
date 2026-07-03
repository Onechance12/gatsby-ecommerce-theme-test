FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
CMD ["npm", "start"]
