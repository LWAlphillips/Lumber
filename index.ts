import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { authHandler } from "./auth";
import { buildServer } from "./tools";

// Must match the deployed Worker URL. Change it if you rename the Worker or add a custom domain.
const ORIGIN = "https://lwa-lumber-mcp.lwalphillips.workers.dev";

const mcp = createMcpHandler(buildServer, { route: "/mcp" });

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: { fetch: (req, env, ctx) => mcp(req, env, ctx) },
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ["timesheets:read"],
  resourceMetadata: {
    resource: `${ORIGIN}/mcp`,
    authorization_servers: [ORIGIN],
  },
});
