# ZAK MCP Gateway: Implementation Roadmap & Architecture Guide

A simple, phase-by-phase guide to building the Token-Optimized MCP Gateway.

---

## 1. What is ZAK MCP Gateway?

- AI agents waste thousands of tokens loading large tool schemas on startup.
- Raw tool outputs also dump huge JSON files into the AI conversation.
- **ZAK MCP Gateway** sits in the middle as an intelligent filter.
- It exposes only 2 meta-tools, converts schemas to short TypeScript, and trims unnecessary data.

---

## 2. Before vs After: The Core Difference

```mermaid
flowchart TD
    subgraph Traditional["❌ Without Gateway (Heavy & Expensive)"]
        A1["AI Agent (Cursor / Claude)"] -->|"Loads 50+ Full JSON Schemas (~30,000 tokens)"| B1["Many MCP Servers"]
        B1 -->|"Returns 80-Field Raw Payloads"| A1
    end

    subgraph Optimized["✅ With ZAK MCP Gateway (Fast & Cheap)"]
        A2["AI Agent (Cursor / Claude)"] -->|"Loads only 2 Meta-Tools (~300 tokens)"| G["ZAK MCP Gateway"]
        G -->|"Finds tools on demand"| B2["Downstream Servers"]
        B2 -->|"Filters out unwanted fields"| G
        G -->|"Returns clean, tiny response"| A2
    end
```

---

## 3. How It Works (In 3 Simple Steps)

```mermaid
sequenceDiagram
    autonumber
    actor Agent as AI Agent (Claude/Cursor)
    participant Gateway as ZAK MCP Gateway
    participant Server as Downstream Server (GitHub/DB)

    Agent->>Gateway: Step 1: mcp_search_tools("create issue")
    Gateway-->>Agent: Returns tiny TypeScript signature (36 tokens)

    Agent->>Gateway: Step 2: mcp_call_tool("github::create_issue", args, project_fields)
    Gateway->>Server: Forwards call downstream
    Server-->>Gateway: Raw API response (huge JSON)

    Gateway->>Gateway: Step 3: Prunes nulls & keeps only project_fields
    Gateway-->>Agent: Clean, compact output
```

---

## 4. Phase-Wise Development Roadmap

```mermaid
flowchart LR
    P1["Phase 1<br/><b>Core Stdio Proxy</b><br/>• Connect servers<br/>• BM25 search"] --> P2["Phase 2<br/><b>Schema Compaction</b><br/>• JSON to TS<br/>• Token savings"]
    P2 --> P3["Phase 3<br/><b>Egress & Caching</b><br/>• JSONPath mask<br/>• SHA-256 cache"]
    P3 --> P4["Phase 4<br/><b>Integration & Sandbox</b><br/>• Cursor / Claude test<br/>• Code Mode"]
```

---

### Phase 1: Core Stdio Proxy & Discovery (MVP)

**Goal:** Allow the AI agent to connect to the gateway and search for tools.

```mermaid
flowchart TD
    A["Gateway Starts"] --> B["Reads config/servers.json"]
    B --> C["Spawns Downstream Child Processes (GitHub, DB)"]
    C --> D["Fetches tool list from each server"]
    D --> E["Builds MiniSearch BM25 Lexical Index"]
    E --> F["Listens on Stdio for Agent requests"]
```

**Tasks:**
- Read server configurations from `config/servers.json`.
- Connect to downstream MCP servers over stdio child processes.
- Index all tool names and descriptions in `MiniSearch`.
- Serve `mcp_search_tools` to the AI client.

---

### Phase 2: Schema Compaction (JSON Schema ➔ TypeScript)

**Goal:** Reduce schema token consumption by over 80%.

```mermaid
flowchart LR
    J["Draft-07 JSON Schema<br/>(~192 tokens)"] -->|"Synthesizer"| T["Compact TypeScript Signature<br/>(~36 tokens)"]
```

**Tasks:**
- Strip out structural keywords like `properties`, `type`, and `additionalProperties`.
- Convert parameter definitions into clean TypeScript function signatures.
- Add server namespaces (for example, `github::create_issue`).
- Verify syntax with automated unit tests.

---

### Phase 3: Egress Filtering & Smart Caching

**Goal:** Eliminate payload flooding and prevent duplicate tool executions.

```mermaid
flowchart TD
    Call["Tool Call Received"] --> Check{"Is Safe to Cache?"}
    Check -- Yes --> Cache{"SHA-256 Hit?"}
    Cache -- Yes --> Hit["Return Cached Result (0 Tokens)"]
    Cache -- No --> Exec["Execute Downstream Tool"]
    Check -- No (Mutation) --> Exec

    Exec --> Filter["Apply project_fields Mask"]
    Filter --> Prune["Remove Nulls & Empty Arrays"]
    Prune --> Save["Save to Cache (if read-only)"]
    Save --> Return["Return to Agent"]
```

**Tasks:**
- Implement `project_fields` to extract only requested keys (e.g. `status.name`).
- Prune `null`, `undefined`, and empty collections.
- Add SHA-256 caching for idempotent/read-only calls.
- Protect mutation tools (`create`, `delete`, `update`) from being cached.

---

### Phase 4: Client Integration & Code Sandbox

**Goal:** Test with real developer tools and support code execution.

```mermaid
flowchart TD
    Client["Cursor / Claude Desktop"] -->|"stdio"| Gateway["ZAK MCP Gateway"]
    Gateway -->|"Standard Calls"| S1["Downstream MCPs"]
    Gateway -->|"Code Mode (JS / WASM)"| S2["Ephemeral Sandbox"]
```

**Tasks:**
- Mount the gateway in `claude_desktop_config.json` and `.cursor/mcp.json`.
- Benchmark token consumption in real 15-turn coding sessions.
- Add an isolated sandbox for executing multi-tool scripts in a single roundtrip.

---

## 5. Summary Checklist for Tomorrow

- [x] Folder structure and types configured.
- [x] Baseline compilation and smoke tests passing.
- [ ] Connect real test MCP server (e.g., Filesystem or GitHub).
- [ ] Test `mcp_search_tools` through Stdio pipe.
- [ ] Verify payload trimming on large responses.
