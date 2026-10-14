#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeBrowser, createServer } from "./server.js";

async function main() {
  const server = createServer();

  // Cleanup on exit. The listener must not return a promise: a rejected close would skip the exit.
  process.on("SIGINT", () => {
    closeBrowser().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Failed to close the browser:", error);
        process.exit(1);
      }
    );
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Woolworths MCP Server running on stdio");
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
