import test from "node:test";
import assert from "node:assert/strict";
import { SchemaTranspiler } from "../dist/synthesizer/ts-transpiler.js";
import { ProjectionFilter } from "../dist/distiller/projection-filter.js";
import { NullPruner } from "../dist/distiller/null-pruner.js";
import { ToolDiscoveryEngine } from "../dist/discovery/search-index.js";

test("SchemaTranspiler produces compact TypeScript signatures", () => {
  const tool = {
    serverId: "github",
    name: "create_issue",
    namespacedName: "github::create_issue",
    description: "Create tracker issue",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        priority: { type: "string", enum: ["low", "high"] },
        body: { type: "string" }
      },
      required: ["title"]
    }
  };

  const ts = SchemaTranspiler.transpileToTypeScript(tool);
  assert.ok(ts.includes("github::create_issue"));
  assert.ok(ts.includes("title: string"));
  assert.ok(ts.includes("priority?: \"low\" | \"high\""));
  assert.ok(ts.includes("body?: string"));
});

test("ProjectionFilter filters nested properties correctly", () => {
  const payload = {
    id: "123",
    status: { id: 1, name: "In Progress" },
    author: { name: "Zack", email: "secret@example.com" },
    tags: ["feature", "mcp"]
  };

  const filtered = ProjectionFilter.project(payload, ["status.name", "author.name"]);
  assert.deepEqual(filtered, {
    status: { name: "In Progress" },
    author: { name: "Zack" }
  });
});

test("NullPruner eliminates empty and null fields", () => {
  const payload = {
    keep: "hello",
    removeMe: null,
    nested: {
      valid: 42,
      emptyVal: undefined
    }
  };

  const cleaned = NullPruner.prune(payload);
  assert.deepEqual(cleaned, {
    keep: "hello",
    nested: { valid: 42 }
  });
});

test("ToolDiscoveryEngine indexes and retrieves matching tools", () => {
  const engine = new ToolDiscoveryEngine();
  engine.registerTools([
    {
      serverId: "github",
      name: "create_issue",
      namespacedName: "github::create_issue",
      description: "Create an issue in a repository",
      inputSchema: { type: "object", properties: { title: { type: "string" } } }
    },
    {
      serverId: "postgres",
      name: "query",
      namespacedName: "postgres::query",
      description: "Run SQL SELECT query on database",
      inputSchema: { type: "object", properties: { sql: { type: "string" } } }
    }
  ]);

  const results = engine.search("github issue");
  assert.equal(results.length, 1);
  assert.equal(results[0].namespacedName, "github::create_issue");
});
