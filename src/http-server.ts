#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getBearerHandler, WebApi } from "azure-devops-node-api";
import type { Request, Response, NextFunction } from "express";

import { createAuthenticator } from "./auth.js";
import { logger } from "./logger.js";
import { getOrgTenant } from "./org-tenants.js";
import { configureAllTools } from "./tools.js";
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";
import { DomainsManager } from "./shared/domains.js";

// --- Configuration from environment variables ---
const orgName: string = process.env.ADO_ORGANIZATION ?? "";
if (!orgName) {
  logger.error("ADO_ORGANIZATION environment variable is required");
  process.exit(1);
}

const orgUrl = "https://dev.azure.com/" + orgName;
const port = parseInt(process.env.PORT || "8080", 10);
const mcpApiKey = process.env.MCP_API_KEY;
const authType = process.env.ADO_AUTH_TYPE || "envvar";
const tenantIdEnv = process.env.ADO_TENANT_ID;
const domainsInput = process.env.ADO_DOMAINS || "all";

const domainsManager = new DomainsManager(domainsInput);
const enabledDomains = domainsManager.getEnabledDomains();

// --- API Key Authentication Middleware ---
function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  if (!mcpApiKey) {
    // No API key configured — allow all requests (not recommended in production)
    logger.warn("MCP_API_KEY is not set — API key authentication is disabled");
    next();
    return;
  }

  const providedKey = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");

  if (!providedKey || providedKey !== mcpApiKey) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: Invalid or missing API key" },
      id: null,
    });
    return;
  }

  next();
}

// --- Azure DevOps Client Factory ---
function getAzureDevOpsClient(getAzureDevOpsToken: () => Promise<string>, userAgentComposer: UserAgentComposer): () => Promise<WebApi> {
  return async () => {
    const accessToken = await getAzureDevOpsToken();
    const authHandler = getBearerHandler(accessToken);
    const connection = new WebApi(orgUrl, authHandler, undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });
    return connection;
  };
}

// --- Create a fully configured MCP server instance ---
function createConfiguredServer(authenticator: () => Promise<string>, userAgentComposer: UserAgentComposer): McpServer {
  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
    icons: [{ src: "https://cdn.vsassets.io/content/icons/favicon.ico" }],
  });

  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };

  configureAllTools(server, authenticator, getAzureDevOpsClient(authenticator, userAgentComposer), () => userAgentComposer.userAgent, enabledDomains, orgName);

  return server;
}

// --- Main ---
async function main() {
  logger.info("Starting Azure DevOps MCP HTTP Server", {
    organization: orgName,
    organizationUrl: orgUrl,
    authentication: authType,
    tenant: tenantIdEnv,
    domains: domainsInput,
    enabledDomains: Array.from(enabledDomains),
    version: packageVersion,
    port,
    apiKeyConfigured: !!mcpApiKey,
  });

  const tenantId = (await getOrgTenant(orgName)) ?? tenantIdEnv;
  const authenticator = createAuthenticator(authType, tenantId);
  const userAgentComposer = new UserAgentComposer(packageVersion);

  const app = createMcpExpressApp({ host: "0.0.0.0" });

  // Session transport map
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // Health check endpoint (no auth required)
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", version: packageVersion, organization: orgName });
  });

  // MCP POST endpoint
  app.post("/mcp", apiKeyAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            logger.info(`Session initialized: ${sid}`);
            transports[sid] = transport;
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            logger.info(`Session closed: ${sid}`);
            delete transports[sid];
          }
        };

        const server = createConfiguredServer(authenticator, userAgentComposer);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("Error handling MCP POST request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // MCP GET endpoint (SSE streams)
  app.get("/mcp", apiKeyAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session ID" },
        id: null,
      });
      return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  });

  // MCP DELETE endpoint (session termination)
  app.delete("/mcp", apiKeyAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session ID" },
        id: null,
      });
      return;
    }

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error("Error handling session termination:", error);
      if (!res.headersSent) {
        res.status(500).send("Error processing session termination");
      }
    }
  });

  // Start listening
  app.listen(port, "0.0.0.0", () => {
    logger.info(`MCP Streamable HTTP Server listening on port ${port}`);
    console.log(`MCP Streamable HTTP Server listening on http://0.0.0.0:${port}/mcp`);
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    logger.info("Shutting down server...");
    for (const sessionId in transports) {
      try {
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        logger.error(`Error closing transport for session ${sessionId}:`, error);
      }
    }
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM, shutting down...");
    for (const sessionId in transports) {
      try {
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        logger.error(`Error closing transport for session ${sessionId}:`, error);
      }
    }
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});
