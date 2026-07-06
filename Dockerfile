FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

ENV PORT=3000
ENV GITHUB_RAW_BASE=https://raw.githubusercontent.com/Xinyuan-LilyGO/documentation/master/en/products

EXPOSE 3000

CMD ["node", "dist/index.js"]
