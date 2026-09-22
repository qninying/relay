// The resource/tool registrations for Relay's MCP server. Factored out of index.ts
// so the registration logic stays testable and reusable if a second transport
// (e.g. HTTP, for a non-local client) is added later — same split CoreOps uses
// between mcpServerFactory.ts and index.ts/httpMcpServer.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// No real job queue exists yet (STORY-001/002 build it). This resource returns
// fixture data so the MCP surface — and the shape of needs_review as a distinct
// third outcome, not success/failed — can be demonstrated and registered now.
// Every entry says source: "fixture" explicitly, so a client is never left
// guessing whether this is live or placeholder data. Once the real queue exists,
// this swaps to reading it, keeping the same honest "source" field.
const FIXTURE_NEEDS_REVIEW_JOBS = [
  {
    jobId: "job-fx-001",
    jobType: "lead_enrichment",
    status: "needs_review",
    confidence: 0.41,
    reason: "classification confidence below threshold",
  },
  {
    jobId: "job-fx-002",
    jobType: "lead_enrichment",
    status: "needs_review",
    confidence: 0.38,
    reason: "classification confidence below threshold",
  },
];

export function createRelayMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "relay-mcp-server",
      version: "0.1.0",
    },
    // Without declaring this, a connected client silently drops every
    // notifications/message this server sends — no error either side.
    {
      capabilities: { logging: {} },
    }
  );

  server.registerResource(
    "jobs-needs-review",
    "relay://jobs/needs-review",
    {
      title: "Relay jobs: needs_review queue",
      description:
        'Read-only list of jobs routed to needs_review — REQ-010\'s third outcome, distinct from success and dead-lettered failure, for a job whose classification confidence fell below threshold. Fixture data until the real queue (STORY-001/002) exists; this response\'s own "source" field says so honestly.',
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ source: "fixture", jobs: FIXTURE_NEEDS_REVIEW_JOBS }, null, 2),
        },
      ],
    })
  );

  server.registerTool(
    "submit_batch_job",
    {
      title: "Submit a batch job",
      description:
        "STUB — accepts a batch job submission but does not enqueue or process it yet; no job queue exists until STORY-001/002 are built. Always returns an explicit stub acknowledgment, never a fabricated success.",
      inputSchema: {
        jobType: z.string().describe('The job type, e.g. "lead_enrichment"'),
        items: z.array(z.string()).min(1).describe("Item identifiers or URLs to process"),
      },
    },
    async ({ jobType, items }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              stub: true,
              accepted: false,
              message: `submit_batch_job is a stub — ${items.length} item(s) of type "${jobType}" were received but not enqueued; no job queue exists yet.`,
            },
            null,
            2
          ),
        },
      ],
    })
  );

  return server;
}
