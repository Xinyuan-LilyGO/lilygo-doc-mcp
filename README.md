# lilygo-doc-mcp

MCP server for [LILYGO](https://www.lilygo.cc) product documentation. Exposes LILYGO hardware docs as structured tools for LLM clients via the [Model Context Protocol](https://modelcontextprotocol.io).

Documentation is served from a local sparse git checkout of [Xinyuan-LilyGO/documentation](https://github.com/Xinyuan-LilyGO/documentation). No runtime GitHub API calls — zero rate limit issues. Docs can stay up to date automatically via a GitHub webhook.

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/your-org/lilygo-doc-mcp
cd lilygo-doc-mcp
npm install
npm run docs:init
npm run build
```

`npm run docs:init` clones only the `en/products` documentation subtree into `vendor/docs`.

To point at another docs checkout, set `DOCS_REPO_DIR` before running the command:

```bash
DOCS_REPO_DIR=/path/to/documentation npm run docs:update
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
      "type": "sse",
      "url": "http://localhost:3000/sse"
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
1. Run `node scripts/update-docs.mjs`
2. Reload the in-memory product cache. Product categories are discovered automatically.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sse` | `GET` | MCP SSE connection endpoint |
| `/messages` | `POST` | MCP SSE message endpoint |
| `/webhook` | `POST` | GitHub push webhook |
| `/health` | `GET` | Returns `{ status, products }` |

## Logging

The server logs MCP SSE connections, message requests, disconnections, and tool calls. Tool-call logs include the tool name and arguments, but not returned document content.

Follow logs from Docker with:

```bash
docker logs -f lilygo-doc-mcp
```

## Tools

| Tool | Description |
|------|-------------|
| `list_products` | List all products, filter by series / tags / keyword |
| `get_product` | Get full docs plus the programming guide, or a specific section (overview, quickstart, features, parameters, pins, faq) |
| `get_product_guide` | Get the dedicated `quick-start.md` programming guide, including SDK setup, dependencies, and code examples |
| `search_products` | Full-text search across product pages and programming guides with ranked excerpts |
| `get_product_specs` | Extract structured specs: key features, parameter table, pin tables |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `GITHUB_WEBHOOK_SECRET` | _(empty)_ | GitHub webhook secret for signature verification. If unset, signature check is skipped. |
| `DOCS_DIR` | `vendor/docs/en/products` | Path to local documentation directory |
| `DOCS_REPO_DIR` | `vendor/docs` | Path to the local documentation git checkout updated by `docs:init`, `docs:update`, and webhook pushes |
| `DOCS_REPO_URL` | `https://github.com/Xinyuan-LilyGO/documentation.git` | Documentation repository URL |
| `DOCS_REPO_BRANCH` | `master` | Documentation repository branch |
| `DOCS_SPARSE_PATH` | `en/products` | Sparse checkout path to serve |

## Docker

Create the shared Docker network once. It is harmless locally and lets Nginx Proxy Manager reach the service in production:

```bash
docker network inspect npm_proxy >/dev/null 2>&1 || docker network create npm_proxy
cp .env.example .env
```

Run the published GHCR image:

```bash
docker compose pull
docker compose up -d --wait
```

Build and run the current local source instead:

```bash
docker compose -f compose.yaml -f compose.local.yaml up -d --build --wait
```

The service is bound to `127.0.0.1:3000` by default:

```bash
curl http://127.0.0.1:3000/health
```

Set `LILYGO_DOC_MCP_BIND_ADDRESS=0.0.0.0` only when direct LAN access is intentional. Public deployments should keep the loopback binding and expose the service through Nginx Proxy Manager on the shared `npm_proxy` network.

## License

MIT
