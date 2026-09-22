import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRelayMcpServer } from "./mcpServerFactory.js";

// Relay MCP Tool Gateway (R2): a stdio MCP server exposing job status and
// submission to AI agents, alongside the human-facing dashboard. stdio is a
// same-machine parent-child pipe — one client process, one server process,
// no notion of "which caller" beyond that, same assumption CoreOps'
// TRANSPORT_DECISION documents.

async function main() {
  const server = createRelayMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Written to stderr, not stdout — stdout is the JSON-RPC protocol channel
  // itself on this transport; anything else on it would corrupt the stream.
  console.error("relay-mcp-server: connected over stdio");
}

main().catch((error) => {
  console.error("relay-mcp-server: fatal startup error", error);
  process.exit(1);
});
