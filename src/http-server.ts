#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
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

  // Health check endpoint (no auth required)
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", version: packageVersion, organization: orgName });
  });

  // MCP POST endpoint — stateless: a fresh server + transport per request.
  // This avoids in-memory session state, which does not survive scale-to-zero
  // or load-balancing across multiple replicas on Azure Container Apps.
  app.post("/mcp", apiKeyAuth, async (req: Request, res: Response) => {
    const server = createConfiguredServer(authenticator, userAgentComposer);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session tracking
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
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

  // In stateless mode there are no sessions, so server-initiated SSE streams
  // (GET) and session termination (DELETE) are not supported.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: server runs in stateless mode" },
      id: null,
    });
  };
  app.get("/mcp", apiKeyAuth, methodNotAllowed);
  app.delete("/mcp", apiKeyAuth, methodNotAllowed);

  // Start listening
  app.listen(port, "0.0.0.0", () => {
    logger.info(`MCP Streamable HTTP Server listening on port ${port}`);
    console.log(`MCP Streamable HTTP Server listening on http://0.0.0.0:${port}/mcp`);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    logger.info("Shutting down server...");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    logger.info("Received SIGTERM, shutting down...");
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});
