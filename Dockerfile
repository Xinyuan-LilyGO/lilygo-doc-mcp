FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY .gitmodules ./

# Clone only the en/products subtree to keep image size small
RUN git clone --filter=blob:none --sparse --depth 1 \
    https://github.com/Xinyuan-LilyGO/documentation.git vendor/docs && \
    git -C vendor/docs sparse-checkout set en/products

ENV PORT=3000
ENV DOCS_DIR=/app/vendor/docs/en/products

EXPOSE 3000

CMD ["node", "dist/index.js"]
