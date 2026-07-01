#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, registerResources } from "./tools.js";

async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "garmin-connect-mcp",
    version: "0.1.0",
  });

  registerTools(server);
  registerResources(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("garmin-connect-mcp server running on stdio");
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "login") {
    if (process.argv.includes("--auto")) {
      const { performAutoLogin } = await import("./dashboard-login.js");
      const result = await performAutoLogin();
      console.error(result.message);
      process.exit(result.ok ? 0 : 1);
    }
    const { runLogin } = await import("./auth.js");
    await runLogin();
  } else if (command === "save-credentials") {
    const { saveCredentials, getCredentialsFile } =
      await import("./credentials.js");
    const email = process.env.GARMIN_EMAIL;
    const password = process.env.GARMIN_PASSWORD;
    if (!email || !password) {
      console.error(
        "Set GARMIN_EMAIL and GARMIN_PASSWORD, then run:\n" +
          "  GARMIN_EMAIL=you@example.com GARMIN_PASSWORD='...' node dist/index.js save-credentials"
      );
      process.exit(1);
    }
    saveCredentials(email, password);
    console.error(`Saved credentials to ${getCredentialsFile()} (mode 0600).`);
  } else if (command === "dashboard") {
    const { startDashboard } = await import("./dashboard.js");
    await startDashboard();
  } else {
    await startMcpServer();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
