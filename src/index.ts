#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export function resolveDefaultDocsDir(moduleUrl = import.meta.url): string {
  const repoRoot = join(dirname(fileURLToPath(moduleUrl)), "..");
  return join(repoRoot, "vendor/docs/en/products");
}

// ── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = process.env.DOCS_DIR ?? resolveDefaultDocsDir();

// ── Types ──────────────────────────────────────────────────────────────────

interface ProductMeta {
  category: string;
  product: string;
  title: string;
  tags: string[];
  shopLink: string;
}

// ── Local file reading ─────────────────────────────────────────────────────

async function readLocalFile(docsDir: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(join(docsDir, relPath), "utf-8");
  } catch {
    return null;
  }
}

async function listLocalDir(docsDir: string, relPath: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(docsDir, relPath), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && e.name !== "index").map((e) => e.name);
  } catch {
    return [];
  }
}

// ── Markdown parsing helpers ───────────────────────────────────────────────

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { data, body: match[2] };
}

function extractShopLink(body: string): string {
  const m = body.match(/<ShopLink href="([^"]+)"/);
  return m ? m[1] : "";
}

function extractSection(body: string, heading: RegExp): string {
  const lines = body.split(/\r?\n/);
  let inside = false;
  let sectionLevel = 2;
  const collected: string[] = [];

  for (const line of lines) {
    const hMatch = line.match(/^(#{1,4}) /);
    if (hMatch) {
      const level = hMatch[1].length;
      if (inside) {
        if (level <= sectionLevel) break;
      } else if (heading.test(line)) {
        inside = true;
        sectionLevel = level;
        continue;
      }
    }
    if (inside) collected.push(line);
  }
  return collected.join("\n").trim();
}

function parseMarkdownTables(text: string): Array<Record<string, string>[]> {
  const results: Array<Record<string, string>[]> = [];
  const lines = text.split(/\r?\n/);
  let headers: string[] | null = null;
  let rows: Record<string, string>[] = [];

  const flush = () => {
    if (headers && rows.length) results.push(rows);
    headers = null;
    rows = [];
  };

  for (const line of lines) {
    if (!line.trim().startsWith("|")) { flush(); continue; }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.every((c) => /^[-: ]+$/.test(c))) continue;
    if (!headers) {
      headers = cells;
    } else {
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = cells[i] ?? ""; });
      rows.push(row);
    }
  }
  flush();
  return results;
}

// ── Product index (in-memory cache, reloaded on webhook) ──────────────────

const productCaches = new Map<string, ProductMeta[]>();

async function loadProducts(docsDir: string): Promise<ProductMeta[]> {
  const entries: Array<{ category: string; product: string }> = [];
  const categories = await listLocalDir(docsDir, "");
  for (const category of categories) {
    const products = await listLocalDir(docsDir, category);
    for (const product of products) {
      entries.push({ category, product });
    }
  }

  const products: ProductMeta[] = [];
  await Promise.all(
    entries.map(async ({ category, product }) => {
      const raw = await readLocalFile(docsDir, `${category}/${product}/index.md`);
      if (!raw) return;
      const { data, body } = parseFrontmatter(raw);
      products.push({
        category,
        product,
        title: data.title ?? product,
        tags: data.tags ? data.tags.split(",").map((t) => t.trim()) : [],
        shopLink: extractShopLink(body),
      });
    })
  );
  return products;
}

async function getProducts(docsDir: string): Promise<ProductMeta[]> {
  let products = productCaches.get(docsDir);
  if (!products) {
    products = await loadProducts(docsDir);
    productCaches.set(docsDir, products);
  }
  return products;
}

async function reloadProducts(docsDir: string): Promise<void> {
  const products = await loadProducts(docsDir);
  productCaches.set(docsDir, products);
  console.error(`[lilygo-docs] reloaded ${products.length} products`);
}

async function fetchProductBody(docsDir: string, meta: ProductMeta): Promise<string> {
  const raw = await readLocalFile(docsDir, `${meta.category}/${meta.product}/index.md`);
  if (!raw) return "";
  return parseFrontmatter(raw).body;
}

async function fetchProductGuide(docsDir: string, meta: ProductMeta): Promise<string> {
  const raw = await readLocalFile(docsDir, `${meta.category}/${meta.product}/quick-start.md`);
  if (!raw) return "";
  return parseFrontmatter(raw).body;
}

async function findProduct(docsDir: string, name: string): Promise<ProductMeta | undefined> {
  const lower = name.toLowerCase().replace(/\s+/g, "-");
  const products = await getProducts(docsDir);
  return products.find(
    (p) =>
      p.product.toLowerCase() === lower ||
      p.title.toLowerCase() === name.toLowerCase()
  );
}

// ── Git submodule update ───────────────────────────────────────────────────

async function pullDocsUpdate(): Promise<void> {
  try {
    await execFileAsync("git", ["-C", REPO_ROOT, "submodule", "update", "--remote", "--merge", "vendor/docs"]);
    console.error("[lilygo-docs] submodule updated");
  } catch (e) {
    console.error("[lilygo-docs] submodule update failed:", e);
  }
}

// ── Webhook signature verification ────────────────────────────────────────

function verifyWebhookSignature(body: string, signature: string | undefined): boolean {
  if (!WEBHOOK_SECRET) return true; // skip verification if no secret configured
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body, "utf-8").digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── MCP Server setup ───────────────────────────────────────────────────────

function logMcpRequest(tool: string, args: Record<string, unknown>): void {
  console.error(`[lilygo-docs] MCP request ${JSON.stringify({ tool, arguments: args })}`);
}

export function createMcpServer(docsDir = DOCS_DIR): McpServer {
  const server = new McpServer({ name: "lilygo-docs", version: "1.0.0" });

  server.registerTool(
    "list_products",
    {
      description: "List LILYGO products. Filter by series (e.g. 't-display-series'), tags (e.g. 'ESP32-S3,LoRa'), or keyword.",
      inputSchema: {
        series: z.string().optional().describe("Filter by series folder name, e.g. 't-deck-series'"),
        tags: z.string().optional().describe("Comma-separated tags to filter by, e.g. 'LoRa,GPS'"),
        keyword: z.string().optional().describe("Keyword to match against title or tags"),
      },
    },
    async ({ series, tags, keyword }) => {
      logMcpRequest("list_products", { series, tags, keyword });
      let products = await getProducts(docsDir);
      if (series) {
        const s = series.toLowerCase();
        products = products.filter((p) => p.category.toLowerCase() === s);
      }
      if (tags) {
        const filterTags = tags.split(",").map((t) => t.trim().toLowerCase());
        products = products.filter((p) =>
          filterTags.every((ft) => p.tags.some((pt) => pt.toLowerCase().includes(ft)))
        );
      }
      if (keyword) {
        const kw = keyword.toLowerCase();
        products = products.filter(
          (p) =>
            p.title.toLowerCase().includes(kw) ||
            p.product.toLowerCase().includes(kw) ||
            p.tags.some((t) => t.toLowerCase().includes(kw))
        );
      }
      return {
        content: [{ type: "text", text: JSON.stringify(products.map(({ category, product, title, tags, shopLink }) => ({ category, product, title, tags, shopLink })), null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_product",
    {
      description: "Get documentation for a LILYGO product. The full response includes both the product page and programming guide; a specific section can also be requested.",
      inputSchema: {
        product: z.string().describe("Product name, e.g. 't-deck', 'T-Lora Pager', 't-display-s3-amoled'"),
        section: z
          .enum(["all", "overview", "quickstart", "features", "parameters", "pins", "faq"])
          .optional()
          .default("all")
          .describe("Section to return. Defaults to 'all'."),
      },
    },
    async ({ product, section }) => {
      logMcpRequest("get_product", { product, section });
      const meta = await findProduct(docsDir, product);
      if (!meta) {
        return {
          content: [{ type: "text", text: `Product "${product}" not found. Use list_products to see available products.` }],
          isError: true,
        };
      }
      const body = await fetchProductBody(docsDir, meta);
      if (!body) {
        return { content: [{ type: "text", text: `Failed to fetch documentation for "${product}".` }], isError: true };
      }
      let text: string;
      switch (section) {
        case "overview":    text = extractSection(body, /overview/i); break;
        case "quickstart":  text = await fetchProductGuide(docsDir, meta); break;
        case "features":    text = extractSection(body, /key.?features/i); break;
        case "parameters":  text = extractSection(body, /product.?param/i); break;
        case "pins":        text = extractSection(body, /pin.?(diagram|map)/i); break;
        case "faq":         text = extractSection(body, /^#{1,3} faq/i); break;
        default: {
          const guide = await fetchProductGuide(docsDir, meta);
          text = guide ? `${body}\n\n---\n\n${guide}` : body;
        }
      }
      if (!text) {
        text = section === "all" ? body : `Section "${section}" not found in ${meta.title} documentation.`;
      }
      return { content: [{ type: "text", text: `# ${meta.title}\n\n${text}` }] };
    }
  );

  server.registerTool(
    "get_product_guide",
    {
      description: "Get the dedicated programming guide for a LILYGO product, including SDK setup, Arduino or PlatformIO configuration, dependency versions, and code examples.",
      inputSchema: {
        product: z.string().describe("Product name, e.g. 't-deck', 't-lora-pager', 't-display-s3'"),
      },
    },
    async ({ product }) => {
      logMcpRequest("get_product_guide", { product });
      const meta = await findProduct(docsDir, product);
      if (!meta) {
        return {
          content: [{ type: "text", text: `Product "${product}" not found. Use list_products to see available products.` }],
          isError: true,
        };
      }
      const guide = await fetchProductGuide(docsDir, meta);
      if (!guide) {
        return {
          content: [{ type: "text", text: `Programming guide not found for "${product}".` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: guide }] };
    }
  );

  server.registerTool(
    "search_products",
    {
      description: "Full-text search across LILYGO product pages and programming guides. Returns matching products with context excerpts.",
      inputSchema: {
        query: z.string().describe("Search query, e.g. 'SX1262 LoRa GPS', 'e-paper display', 'BQ25896'"),
        max_results: z.number().int().min(1).max(20).optional().default(10),
      },
    },
    async ({ query, max_results }) => {
      logMcpRequest("search_products", { query, max_results });
      const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      const products = await getProducts(docsDir);
      const results: Array<{ category: string; product: string; title: string; shopLink: string; score: number; excerpts: string[] }> = [];

      await Promise.all(
        products.map(async (meta) => {
          const [body, guide] = await Promise.all([
            fetchProductBody(docsDir, meta),
            fetchProductGuide(docsDir, meta),
          ]);
          const searchable = `${body}\n${guide}`;
          if (!searchable.trim()) return;
          const lower = searchable.toLowerCase();
          let score = 0;
          const excerpts: string[] = [];
          const lines = searchable.split(/\r?\n/);

          for (const term of terms) {
            let pos = 0;
            let found = 0;
            while ((pos = lower.indexOf(term, pos)) !== -1 && found < 3) {
              let charCount = 0;
              for (const line of lines) {
                charCount += line.length + 1;
                if (charCount > pos) {
                  const excerpt = line.trim();
                  if (excerpt.length > 5 && !excerpts.includes(excerpt)) {
                    excerpts.push(excerpt.slice(0, 120));
                  }
                  break;
                }
              }
              score++;
              found++;
              pos += term.length;
            }
          }
          if (score > 0) {
            results.push({ category: meta.category, product: meta.product, title: meta.title, shopLink: meta.shopLink, score, excerpts: excerpts.slice(0, 3) });
          }
        })
      );

      results.sort((a, b) => b.score - a.score);
      const top = results.slice(0, max_results).map(({ score: _s, ...r }) => r);
      const text = top.length ? JSON.stringify(top, null, 2) : `No products found matching "${query}".`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "get_product_specs",
    {
      description: "Extract structured specifications from a LILYGO product: parameters table, pin mapping, and key features.",
      inputSchema: {
        product: z.string().describe("Product name, e.g. 't-deck', 't-lora-pager'"),
      },
    },
    async ({ product }) => {
      logMcpRequest("get_product_specs", { product });
      const meta = await findProduct(docsDir, product);
      if (!meta) {
        return {
          content: [{ type: "text", text: `Product "${product}" not found. Use list_products to see available products.` }],
          isError: true,
        };
      }
      const body = await fetchProductBody(docsDir, meta);
      if (!body) {
        return { content: [{ type: "text", text: `Failed to fetch documentation for "${product}".` }], isError: true };
      }
      const featuresSection = extractSection(body, /key.?features/i);
      const keyFeatures = featuresSection
        .split(/\r?\n/)
        .filter((l) => l.trim().startsWith("-"))
        .map((l) => l.replace(/^[-*]\s*/, "").trim());
      const paramTables = parseMarkdownTables(extractSection(body, /product.?param/i));
      const pinTables = parseMarkdownTables(extractSection(body, /pin.?(diagram|map)/i));
      return {
        content: [{ type: "text", text: JSON.stringify({ title: meta.title, category: meta.category, product: meta.product, tags: meta.tags, shopLink: meta.shopLink, keyFeatures, parameters: paramTables[0] ?? [], pinTables }, null, 2) }],
      };
    }
  );

  return server;
}

// ── HTTP server ────────────────────────────────────────────────────────────

const sseTransports = new Map<string, SSEServerTransport>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // ── GitHub webhook ────────────────────────────────────────────────────
  if (url.pathname === "/webhook" && req.method === "POST") {
    const body = await readBody(req);
    const sig = req.headers["x-hub-signature-256"] as string | undefined;

    if (!verifyWebhookSignature(body, sig)) {
      res.writeHead(401).end("Unauthorized");
      return;
    }

    const event = req.headers["x-github-event"];
    if (event === "push") {
      res.writeHead(202).end("Accepted");
      pullDocsUpdate().then(() => reloadProducts(DOCS_DIR)).catch((e) => console.error("[lilygo-docs] reload error:", e));
    } else {
      res.writeHead(200).end("OK");
    }
    return;
  }

  // ── Health check ──────────────────────────────────────────────────────
  if (url.pathname === "/health" && req.method === "GET") {
    const count = productCaches.get(DOCS_DIR)?.length ?? -1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", products: count }));
    return;
  }

  // ── MCP SSE endpoint ──────────────────────────────────────────────────
  if (url.pathname === "/sse" && req.method === "GET") {
    const remoteAddress = req.socket.remoteAddress ?? "unknown";
    console.error(`[lilygo-docs] MCP SSE connection request remote=${remoteAddress}`);
    const transport = new SSEServerTransport("/messages", res);
    const mcpServer = createMcpServer(DOCS_DIR);
    await mcpServer.connect(transport);
    sseTransports.set(transport.sessionId, transport);
    console.error(`[lilygo-docs] MCP SSE connected sessionId=${transport.sessionId} remote=${remoteAddress}`);
    res.on("close", () => {
      sseTransports.delete(transport.sessionId);
      console.error(`[lilygo-docs] MCP SSE disconnected sessionId=${transport.sessionId} remote=${remoteAddress}`);
    });
    return;
  }

  if (url.pathname === "/messages" && req.method === "POST") {
    const sessionId = url.searchParams.get("sessionId");
    console.error(`[lilygo-docs] MCP message request sessionId=${sessionId ?? "missing"} remote=${req.socket.remoteAddress ?? "unknown"}`);
    const transport = sessionId ? sseTransports.get(sessionId) : undefined;
    if (!transport) {
      res.writeHead(400).end("No active SSE session");
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404).end("Not found");
});

// ── Start ──────────────────────────────────────────────────────────────────

export async function startServer(): Promise<void> {
  getProducts(DOCS_DIR)
    .then((p) => console.error(`[lilygo-docs] loaded ${p.length} products`))
    .catch((e) => console.error("[lilygo-docs] initial load failed:", e));

  httpServer.listen(PORT, () => {
    console.error(`[lilygo-docs] MCP server listening on http://0.0.0.0:${PORT}/sse`);
    console.error(`[lilygo-docs] Webhook endpoint: POST http://0.0.0.0:${PORT}/webhook`);
    console.error(`[lilygo-docs] Health: GET http://0.0.0.0:${PORT}/health`);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void startServer();
}
