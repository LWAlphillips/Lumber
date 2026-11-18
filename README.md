# LWA Lumber MCP

Claude connector for Lumber timesheets. Runs on Cloudflare Workers, the same way as the Acumatica connector.

- **Read-only.** One tool, `lumber_get_timesheets`. The Worker only sends GET requests to Lumber.
- **Sign-in with Acumatica.** Users log in with their Acumatica account; only people listed in `ALLOWED_USERS` get access.
- **Lumber key stays in Cloudflare.** It's an encrypted Worker secret. Never in this repo, a chat, or a skill.

## Setup

1. **GitHub.** Create a private repo `lwa-lumber-mcp` and upload these files (not `node_modules`).

2. **KV namespace.** Cloudflare → Storage & Databases → KV → Create `lwa-lumber-mcp-oauth`. Paste its ID into `wrangler.jsonc` (`REPLACE_WITH_KV_NAMESPACE_ID`).

3. **Access list.** In `wrangler.jsonc`, set `ALLOWED_USERS` to your Acumatica email. Add more superadmins comma-separated.

4. **Acumatica sign-in.** In SM303010, open the Connected Application the Acumatica connector uses and add this Redirect URI:
   `https://lwa-lumber-mcp.lwalphillips.workers.dev/callback`
   (Or create a separate Connected Application, Authorization Code flow, with that redirect URI.)

5. **Deploy.** Cloudflare → Workers & Pages → Create → Import a repository → `lwa-lumber-mcp`. The Worker name must be `lwa-lumber-mcp`.

6. **Secrets.** Worker → Settings → Variables and Secrets → Add, type **Secret**:
   `ACU_CLIENT_ID`, `ACU_CLIENT_SECRET`, `LUMBER_API_KEY`, `LUMBER_API_SECRET`, `LUMBER_USER_ID`, `LUMBER_COMPANY_ID`

7. **Claude.** Settings → Connectors → Add custom connector → `https://lwa-lumber-mcp.lwalphillips.workers.dev/mcp` → Connect. Allow, sign in to Acumatica.

## Using it

Ask Claude things like:
- "Hours by project for last pay week from Lumber"
- "Lumber timesheets on 25437, Nov 7–13, by employee"
- "Who had overtime last week?"

## Troubleshooting

- **"No access" page after Acumatica login:** the page lists the identifiers Acumatica returned. Put one of them in `ALLOWED_USERS` and redeploy.
- **"Lumber login failed":** check the `LUMBER_*` secrets.
- **403 from Lumber:** the Lumber API user lacks permission for timesheets. Lumber fixes that.
- **Logs:** Worker → Observability.

## Later

- Remove someone: delete them from `ALLOWED_USERS`; their next request is refused.
- Write tools (create/update timesheets) and PM-level filtering are added as new tools in `src/tools.ts` once Lumber answers the permission questions.
