import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  namespace Cloudflare {
    interface Env {
      OAUTH_KV: KVNamespace;
      OAUTH_PROVIDER: OAuthHelpers;
      ACUMATICA_URL: string;
      LUMBER_BASE_URL: string;
      ALLOWED_USERS: string;
      // secrets
      ACU_CLIENT_ID: string;
      ACU_CLIENT_SECRET: string;
      LUMBER_API_KEY: string;
      LUMBER_API_SECRET: string;
      LUMBER_USER_ID: string;
      LUMBER_COMPANY_ID: string;
    }
  }
  type Env = Cloudflare.Env;
}
export {};
