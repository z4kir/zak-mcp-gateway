# Token-Optimized MCP Gateway (TO-MCP / UTOG)

A high-density middleware proxy and gateway designed to eliminate tool schema bloat and payload flooding across downstream [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers.

---

## 🎯 The Core Problem

When autonomous agents (Cursor, Claude Desktop, Claude Code, LangChain) mount multiple MCP servers (GitHub, Jira, Postgres, Slack, Filesystem), standard Draft-07 JSON Schemas are dumped directly into the LLM system prompt:
- **~25,000–50,000 fixed startup schema tokens** before turn 1.
- **>90% unused tools** per session.
- **Payload flooding:** Upstream REST APIs return 50–100KB JSON payloads when the agent only needed 2 fields.

---

## 💡 Key Architectural Pillars

1. **2-Meta-Tool Pattern:** Exposes only `mcp_search_tools` and `mcp_call_tool` (~300 tokens total) instead of dozens of verbose schemas.
2. **Schema Transpiler:** Converts Draft-07 JSON Schema into compact TypeScript operational signatures (80%+ token reduction).
3. **JIT Tool Discovery:** Sub-millisecond BM25 / lexical search over downstream tool registries.
4. **Dual-Tier Decision Gate:** Deterministic SHA-256 exact-match caching for idempotent calls.
5. **Egress Distiller & Projection:** Implements `project_fields` (JSONPath) and null-pruning to eliminate response context bloat.
6. **Code Mode / WASM (Roadmap):** Ephemeral execution sandbox for multi-tool aggregation.

---

## 📁 Project Structure

```
zak-mcp-gateway/
├── docs/                                  # Specifications & Whitepapers
│   ├── Token-Optimized MCP Architecture Whitepaper.pdf
│   └── pdfcrowd.pdf
├── config/                                # Sample gateway configurations
│   └── servers.example.json
├── src/
│   ├── index.ts                           # Public API exports
│   ├── cli.ts                             # CLI entrypoint (--config, stdio runner)
│   ├── types/                             # Type definitions
│   │   ├── tool.ts                        # Tool schemas, signatures & masks
│   │   └── gateway.ts                     # Gateway & downstream server types
│   ├── config/                            # Configuration loader & validation
│   │   ├── schema.ts                      # Zod validation schema
│   │   └── loader.ts                      # JSON config loader
│   ├── discovery/                         # JIT Tool Discovery Engine
│   │   └── search-index.ts                # BM25 MiniSearch index
│   ├── synthesizer/                       # Schema Minification & Transpiler
│   │   └── ts-transpiler.ts               # JSON Schema -> Compact TS transpiler
│   ├── gate/                              # Decision Gate & Caching
│   │   ├── sha-cache.ts                   # Tier-1 SHA-256 exact hit cache
│   │   └── idempotency.ts                 # Mutation vs read-only evaluation
│   ├── distiller/                         # Egress Distiller & Output Projection
│   │   ├── projection-filter.ts           # JSONPath & field whitelist projection
│   │   ├── null-pruner.ts                 # Strips nulls/empty values
│   │   └── format-converter.ts            # JSON array -> compact TSV/tables
│   ├── downstream/                        # Downstream Server Management
│   │   └── client-pool.ts                 # Connection supervisor for downstream MCP servers
│   ├── execution/                         # Execution & Dispatch
│   │   └── dispatcher.ts                  # Routing, cache check & egress processing
│   └── server/                            # MCP Gateway Server
│       ├── meta-tools.ts                  # mcp_search_tools & mcp_call_tool definitions
│       └── gateway-server.ts              # Upstream stdio/SSE MCP server
├── tests/                                 # Unit & Integration test suites
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🚀 Quick Setup & Installation

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run via CLI
node dist/cli.js --config config/servers.example.json
```

---

## 🛠️ Next Steps & Development Roadmap

- [ ] **Day 1:** Core Stdio Proxy verification, Downstream Client connection tests, BM25 indexing.
- [ ] **Day 2:** TypeScript Transpiler edge cases (nested objects, unions, anyOf/allOf).
- [ ] **Day 3:** Egress Distiller & JSONPath testing, TSV format benchmarking.
- [ ] **Day 4:** End-to-end integration with Claude Desktop & Cursor.
