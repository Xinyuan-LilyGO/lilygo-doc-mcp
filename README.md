# lilygo-doc-mcp

MCP server for [LILYGO](https://www.lilygo.cc) product documentation. Exposes LILYGO hardware docs as structured tools for LLM clients via the [Model Context Protocol](https://modelcontextprotocol.io).

Documentation is fetched live from [Xinyuan-LilyGO/documentation](https://github.com/Xinyuan-LilyGO/documentation) on GitHub and cached in memory for 10 minutes.

## Usage

### With npx (recommended)

```json
{
  "mcpServers": {
    "lilygo-docs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "lilygo-doc-mcp"]
    }
  }
}
```

### Install globally

```bash
npm install -g lilygo-doc-mcp
```

```json
{
  "mcpServers": {
    "lilygo-docs": {
      "type": "stdio",
      "command": "lilygo-doc-mcp"
    }
  }
}
```

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
| `GITHUB_RAW_BASE` | `https://raw.githubusercontent.com/Xinyuan-LilyGO/documentation/master/en/products` | Base URL for fetching markdown files |

## Run locally

```bash
npm install
npm run build
npm start
```

## License

MIT
