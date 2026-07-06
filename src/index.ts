#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Config ─────────────────────────────────────────────────────────────────

const GITHUB_RAW_BASE =
  process.env.GITHUB_RAW_BASE ??
  "https://raw.githubusercontent.com/Xinyuan-LilyGO/documentation/master/en/products";

// ── Types ──────────────────────────────────────────────────────────────────

interface ProductMeta {
  category: string;
  product: string;
  title: string;
  tags: string[];
  shopLink: string;
}

// ── GitHub index fetching ──────────────────────────────────────────────────

const KNOWN_CATEGORIES = [
  "industrial-series",
  "other",
  "t-beam-series",
  "t-camera-series",
  "t-connect-series",
  "t-deck-series",
  "t-display-series",
  "t-dongle-series",
  "t-echo-series",
  "t-embed-series",
  "t-encoder-series",
  "t-eth-series",
  "t-halow-series",
  "t-lora-series",
  "t-relay-series",
  "t-sim-series",
  "t-twr-series",
  "t-watch-series",
  "t3-series",
];

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
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

// ── Product index (fetched from GitHub, cached in memory) ─────────────────

let _cache: ProductMeta[] | null = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchManifest(): Promise<Array<{ category: string; product: string }> | null> {
  const url = GITHUB_RAW_BASE.replace(/\/en\/products$/, "") + "/en/products/manifest.json";
  const text = await fetchText(url);
  if (!text) return null;
  try {
    return JSON.parse(text) as Array<{ category: string; product: string }>;
  } catch {
    return null;
  }
}

async function getProducts(): Promise<ProductMeta[]> {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;

  const manifest = await fetchManifest();
  let entries: Array<{ category: string; product: string }>;

  if (manifest) {
    entries = manifest;
  } else {
    entries = [];
    for (const category of KNOWN_CATEGORIES) {
      const indexUrl = `${GITHUB_RAW_BASE}/${category}/index.md`;
      const text = await fetchText(indexUrl);
      if (!text) continue;
      const links = [...text.matchAll(/\[.*?\]\(([a-z0-9-]+)\/?(?:index\.md)?\)/gi)];
      for (const [, product] of links) {
        if (product && product !== "index") {
          entries.push({ category, product });
        }
      }
    }
  }

  const products: ProductMeta[] = [];
  await Promise.all(
    entries.map(async ({ category, product }) => {
      const url = `${GITHUB_RAW_BASE}/${category}/${product}/index.md`;
      const raw = await fetchText(url);
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

  _cache = products;
  _cacheTs = now;
  return products;
}

async function fetchProductBody(meta: ProductMeta): Promise<string> {
  const url = `${GITHUB_RAW_BASE}/${meta.category}/${meta.product}/index.md`;
  const raw = await fetchText(url);
  if (!raw) return "";
  return parseFrontmatter(raw).body;
}

async function findProduct(name: string): Promise<ProductMeta | undefined> {
  const lower = name.toLowerCase().replace(/\s+/g, "-");
  const products = await getProducts();
  return products.find(
    (p) =>
      p.product.toLowerCase() === lower ||
      p.title.toLowerCase() === name.toLowerCase()
  );
}

// ── MCP Server ─────────────────────────────────────────────────────────────

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
    let products = await getProducts();

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
    description: "Get the documentation for a specific LILYGO product. Returns the full markdown or a specific section.",
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
    const meta = await findProduct(product);
    if (!meta) {
      return {
        content: [{ type: "text", text: `Product "${product}" not found. Use list_products to see available products.` }],
        isError: true,
      };
    }

    const body = await fetchProductBody(meta);
    if (!body) {
      return { content: [{ type: "text", text: `Failed to fetch documentation for "${product}".` }], isError: true };
    }

    let text: string;
    switch (section) {
      case "overview":    text = extractSection(body, /overview/i); break;
      case "quickstart":  text = extractSection(body, /quick.?start/i); break;
      case "features":    text = extractSection(body, /key.?features/i); break;
      case "parameters":  text = extractSection(body, /product.?param/i); break;
      case "pins":        text = extractSection(body, /pin.?(diagram|map)/i); break;
      case "faq":         text = extractSection(body, /^#{1,3} faq/i); break;
      default:            text = body;
    }

    if (!text) {
      text = section === "all" ? body : `Section "${section}" not found in ${meta.title} documentation.`;
    }

    return { content: [{ type: "text", text: `# ${meta.title}\n\n${text}` }] };
  }
);

server.registerTool(
  "search_products",
  {
    description: "Full-text search across all LILYGO product documentation. Returns matching products with context excerpts.",
    inputSchema: {
      query: z.string().describe("Search query, e.g. 'SX1262 LoRa GPS', 'e-paper display', 'BQ25896'"),
      max_results: z.number().int().min(1).max(20).optional().default(10),
    },
  },
  async ({ query, max_results }) => {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    const products = await getProducts();

    const results: Array<{ category: string; product: string; title: string; shopLink: string; score: number; excerpts: string[] }> = [];

    await Promise.all(
      products.map(async (meta) => {
        const body = await fetchProductBody(meta);
        if (!body) return;
        const lower = body.toLowerCase();
        let score = 0;
        const excerpts: string[] = [];
        const lines = body.split(/\r?\n/);

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
    const meta = await findProduct(product);
    if (!meta) {
      return {
        content: [{ type: "text", text: `Product "${product}" not found. Use list_products to see available products.` }],
        isError: true,
      };
    }

    const body = await fetchProductBody(meta);
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

// ── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
