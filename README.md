# lilygo-doc-mcp

MCP server for [LILYGO](https://www.lilygo.cc) product documentation. Exposes LILYGO hardware docs as structured tools for LLM clients via the [Model Context Protocol](https://modelcontextprotocol.io).

Documentation is served from a local git submodule of [Xinyuan-LilyGO/documentation](https://github.com/Xinyuan-LilyGO/documentation). No runtime GitHub API calls — zero rate limit issues. Docs stay up-to-date automatically via a GitHub webhook.

## Quick start

### 1. Clone with submodule

```bash
git clone --recurse-submodules https://github.com/your-org/lilygo-doc-mcp
cd lilygo-doc-mcp
npm install
npm run build
```

If you cloned without `--recurse-submodules`, run:

```bash
npm run docs:init
```

### 2. Start the server

```bash
PORT=3000 npm start
```

### 3. Connect your MCP client

```json
{
  "mcpServers": {
    "lilygo-docs": {
      "type": "streamable-http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Keeping docs up to date

### Manual update

```bash
npm run docs:update
```

Then restart the server (or let the webhook do it automatically).

### Automatic via GitHub webhook

Set up a webhook on the [Xinyuan-LilyGO/documentation](https://github.com/Xinyuan-LilyGO/documentation) repository:

1. Go to **Settings → Webhooks → Add webhook**
2. Set **Payload URL** to `https://your-server.com/webhook`
3. Set **Content type** to `application/json`
4. Set a **Secret** (any random string)
5. Choose **Just the push event**

Start the server with the webhook secret:

```bash
GITHUB_WEBHOOK_SECRET=your-secret PORT=3000 npm start
```

On every push to the documentation repo, the server will:
1. Run `git submodule update --remote --merge vendor/docs`
2. Reload the in-memory product cache

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | `POST` / `GET` / `DELETE` | MCP Streamable HTTP transport |
| `/webhook` | `POST` | GitHub push webhook |
| `/health` | `GET` | Returns `{ status, products }` |

## Tools

| Tool | Description |
|------|-------------|
| `list_products` | List all products, filter by series / tags / keyword |
| `get_product` | Get full docs or a specific section (overview, quickstart, features, parameters, pins, faq) |
| `search_products` | Full-text search across all product docs with ranked excerpts |
| `get_product_specs` | Extract structured specs: key features, parameter table, pin tables |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `GITHUB_WEBHOOK_SECRET` | _(empty)_ | GitHub webhook secret for signature verification. If unset, signature check is skipped. |
| `DOCS_DIR` | `vendor/docs/en/products` | Path to local documentation directory |

## Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm ci && npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

Build and run:

```bash
docker build -t lilygo-doc-mcp .
docker run -p 3000:3000 \
  -e GITHUB_WEBHOOK_SECRET=your-secret \
  lilygo-doc-mcp
```

## License

MIT
