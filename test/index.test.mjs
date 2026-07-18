import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, resolveDefaultDocsDir } from "../dist/index.js";

async function createFixture() {
  const docsDir = await mkdtemp(join(tmpdir(), "lilygo-docs-"));
  const productDir = join(docsDir, "new-series", "demo-board");
  await mkdir(productDir, { recursive: true });
  await writeFile(
    join(productDir, "index.md"),
    "---\ntitle: Demo Board\ntags: ESP32-S3\n---\n\n# Demo Board\n\n## Overview\n\nHardware overview.\n",
  );
  await writeFile(
    join(productDir, "quick-start.md"),
    "---\ntitle: Demo Board Quick Start\n---\n\n# Demo Board Quick Start\n\n## Arduino\n\nInstall the UniqueGuideLibrary.\n",
  );
  return docsDir;
}

async function connectClient(docsDir) {
  const server = createMcpServer(docsDir);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("get_product_guide returns the dedicated quick-start document", async () => {
  const docsDir = await createFixture();
  const { client, server } = await connectClient(docsDir);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "get_product_guide"));

    const result = await client.callTool({
      name: "get_product_guide",
      arguments: { product: "demo-board" },
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /UniqueGuideLibrary/);
  } finally {
    await client.close();
    await server.close();
    await rm(docsDir, { recursive: true, force: true });
  }
});

test("default docs directory resolves inside the repository", () => {
  const moduleUrl = pathToFileURL("/workspace/lilygo-doc-mcp/dist/index.js").href;
  assert.equal(
    resolveDefaultDocsDir(moduleUrl),
    join("/workspace/lilygo-doc-mcp", "vendor/docs/en/products"),
  );
});

test("products in newly added category directories are discovered", async () => {
  const docsDir = await createFixture();
  const { client, server } = await connectClient(docsDir);
  try {
    const result = await client.callTool({ name: "list_products", arguments: {} });
    const products = JSON.parse(result.content[0].text);
    assert.equal(products[0].category, "new-series");
    assert.equal(products[0].product, "demo-board");
  } finally {
    await client.close();
    await server.close();
    await rm(docsDir, { recursive: true, force: true });
  }
});

test("get_product quickstart and all sections include the dedicated guide", async () => {
  const docsDir = await createFixture();
  const { client, server } = await connectClient(docsDir);
  try {
    const quickstart = await client.callTool({
      name: "get_product",
      arguments: { product: "demo-board", section: "quickstart" },
    });
    assert.match(quickstart.content[0].text, /UniqueGuideLibrary/);

    const all = await client.callTool({
      name: "get_product",
      arguments: { product: "demo-board", section: "all" },
    });
    assert.match(all.content[0].text, /Hardware overview/);
    assert.match(all.content[0].text, /UniqueGuideLibrary/);
  } finally {
    await client.close();
    await server.close();
    await rm(docsDir, { recursive: true, force: true });
  }
});

test("search_products searches quick-start documents", async () => {
  const docsDir = await createFixture();
  const { client, server } = await connectClient(docsDir);
  try {
    const result = await client.callTool({
      name: "search_products",
      arguments: { query: "UniqueGuideLibrary" },
    });
    const matches = JSON.parse(result.content[0].text);
    assert.equal(matches[0].product, "demo-board");
    assert.ok(matches[0].excerpts.some((excerpt) => excerpt.includes("UniqueGuideLibrary")));
  } finally {
    await client.close();
    await server.close();
    await rm(docsDir, { recursive: true, force: true });
  }
});

test("MCP tool requests are written to the server log", async () => {
  const docsDir = await createFixture();
  const { client, server } = await connectClient(docsDir);
  const messages = [];
  const originalConsoleError = console.error;
  console.error = (...args) => messages.push(args.join(" "));
  try {
    await client.callTool({
      name: "get_product_guide",
      arguments: { product: "demo-board" },
    });
    assert.ok(messages.some((message) =>
      message.includes("MCP request") &&
      message.includes("get_product_guide") &&
      message.includes("demo-board")
    ));
  } finally {
    console.error = originalConsoleError;
    await client.close();
    await server.close();
    await rm(docsDir, { recursive: true, force: true });
  }
});
