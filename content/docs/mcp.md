---
title: MCP server (use logflow-sim as a tool from an LLM)
order: 5
---

# MCP server

logflow-sim ships an [MCP (Model Context Protocol)](https://modelcontextprotocol.io)
server that exposes the kernel as tools. Any MCP-aware client — Claude
Desktop, Continue, Cody, etc. — can use the simulator without going
through the REST API.

Why bother? An LLM that "knows" rsyslog syntax statistically will
happily invent answers about your config. An LLM with the MCP server
attached **simulates the config** and answers from real traces:

> User: *"Why doesn't my SOC get sshd auth failures from web-01?"*
> Claude: *"I parsed your config and replayed a sample auth message —
> the `sshd` programname hits ruleset `catchall` line 16, gets a
> `sourcetype=syslog` from the lookup (no match for sshd because the
> lookup table doesn't have a sshd entry), then your filter on line 24
> drops anything with `sourcetype=syslog` going to your auth bucket.
> Add `sshd: linux:secure` to `lookups/sourcetypes.json` to fix."*

That's a hallucination-killer for ops questions.

## Run it

Clone the repo, install dependencies, build, run:

```bash
git clone https://github.com/gweber/logflow-sim.git
cd logflow-sim
npm install
npm run build:server
node dist/mcp/main.js
```

`dist/mcp/main.js` is the stdio MCP server entrypoint. Point your
MCP-aware client at the absolute path; no global install needed.

## Wire it into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "logflow-sim": {
      "command": "node",
      "args": ["/absolute/path/to/logflow-sim/dist/mcp/main.js"]
    }
  }
}
```

Restart Claude Desktop. The 8 logflow-sim tools should appear in the
tool list. Drop a copy of your `rsyslog.conf` (or any other dialect)
into the chat and ask away.

## Exposed tools

| Tool | What it does |
|---|---|
| `logflow_parse` | Parse a config tree, return the normalized model + diagnostics. |
| `logflow_simulate` | Simulate one message through the parsed config, return the step-by-step trace. |
| `logflow_replay` | Replay a batch (text lines or base64 pcap) and return the aggregate report. |
| `logflow_diff` | Replay through baseline + overlay variants and return per-output and per-rule deltas. |
| `logflow_convert` | Emit a parsed config in another dialect (rsyslog → otel, vector → syslog-ng, …). Optional `sourceSiem`/`targetSiem` triggers destination-side value rewriting. |
| `logflow_retag` | Translate destination-side vocabulary (Splunk → ECS, etc.) without changing pipeline syntax. |
| `logflow_detect` | Run Sigma rules against a replay corpus, return per-rule firing counts. |
| `logflow_validate` | Run the full validator-rule suite and return all findings. |

Every tool takes inline content — no filesystem access from the MCP
server. The LLM client is responsible for getting the config text into
the request.

## Transport

The shipped server speaks JSON-RPC 2.0 over stdio — the same transport
Claude Desktop's MCP client uses. The 200-line implementation in
`src/mcp/main.ts` has zero extra dependencies beyond what the rest of
logflow-sim already pulls in. HTTP-transport mode is a candidate for a
future PR when a use-case shows up (remote tool servers, multi-tenant
deployments).

## Wire format

For developers who want to script against the MCP server directly:

```bash
# Initialize
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | logflow-sim-mcp

# Discover tools
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | logflow-sim-mcp

# Call a tool
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name": "logflow_parse",
  "arguments": {
    "files": [
      { "path": "/rsyslog.conf",
        "content": "module(load=\"imudp\")\\ninput(type=\"imudp\" port=\"514\" ruleset=\"r\")\\nruleset(name=\"r\") { action(type=\"omfile\" file=\"/var/log/messages\") }" }
    ]
  }
}}' | logflow-sim-mcp
```
