// Sign-in for the connector: users authenticate with their Acumatica login (same as the Acumatica connector),
// and only people on ALLOWED_USERS are issued a token.
import { AuthorizationError, CimdFetchError, authorizationErrorRedirect, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { isAllowed } from "./access";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function html(body: string, status = 200, headers = new Headers()) {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>LWA Lumber connector</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5">${body}</body>`,
    { status, headers },
  );
}

function consentPage(d: ConsentDescription, handle: string) {
  const origin = d.clientDomain
    ? `Published by <strong>${esc(d.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return `<h1>Allow ${esc(d.clientName)} to read Lumber timesheets?</h1>
<p>${origin} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>You'll sign in with your Acumatica account next.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p></form>`;
}

async function s256(verifier: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const authHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const oauth = env.OAUTH_PROVIDER;
    try {
      // 1. Claude sends the user here: show consent.
      if (url.pathname === "/authorize" && req.method === "GET") {
        const request = await oauth.parseAuthRequest(req);
        const details = await oauth.describeConsent(request);
        const consent = await oauth.beginConsent(request);
        return html(consentPage(details, consent.handle), 200, consent.headers);
      }

      // 2. User clicked Allow/Deny: on Allow, send them to Acumatica to sign in.
      if (url.pathname === "/authorize" && req.method === "POST") {
        const form = await req.formData();
        const handle = String(form.get("handle"));
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(req, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(req, handle);
        const verifier = crypto.randomUUID() + crypto.randomUUID();
        const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
        const acu = new URL(`${env.ACUMATICA_URL}/identity/connect/authorize`);
        acu.searchParams.set("response_type", "code");
        acu.searchParams.set("client_id", env.ACU_CLIENT_ID);
        acu.searchParams.set("redirect_uri", `${url.origin}/callback`);
        acu.searchParams.set("scope", "openid profile email");
        acu.searchParams.set("state", state);
        acu.searchParams.set("code_challenge", await s256(verifier));
        acu.searchParams.set("code_challenge_method", "S256");
        headers.set("Location", acu.toString());
        return new Response(null, { status: 302, headers });
      }

      // 3. Acumatica sends the user back: identify them, check the access list, issue the token.
      if (url.pathname === "/callback") {
        const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
        const code = url.searchParams.get("code");
        if (url.searchParams.get("error") || !code) {
          headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
          return new Response(null, { status: 302, headers });
        }

        const tokenRes = await fetch(`${env.ACUMATICA_URL}/identity/connect/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: `${url.origin}/callback`,
            client_id: env.ACU_CLIENT_ID,
            client_secret: env.ACU_CLIENT_SECRET,
            code_verifier: data.verifier,
          }),
        });
        if (!tokenRes.ok) return html(`<h1>Acumatica sign-in failed</h1><p>Token exchange returned ${tokenRes.status}.</p>`, 502);
        const { access_token } = (await tokenRes.json()) as { access_token: string };

        const infoRes = await fetch(`${env.ACUMATICA_URL}/identity/connect/userinfo`, {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        if (!infoRes.ok) return html(`<h1>Acumatica sign-in failed</h1><p>Could not read your profile (${infoRes.status}).</p>`, 502);
        const info = (await infoRes.json()) as Record<string, string | undefined>;
        const ids = [info.email, info.preferred_username, info.name, info.sub];
        const user = (ids.find((id) => id && isAllowed(env, [id])) ?? info.email ?? info.preferred_username ?? info.sub ?? "").toLowerCase();

        if (!isAllowed(env, ids)) {
          return html(
            `<h1>No access</h1><p>You signed in as <strong>${esc(info.email ?? info.preferred_username ?? info.name ?? info.sub ?? "unknown")}</strong>, ` +
              `which isn't on this connector's access list.</p><p>Identifiers Acumatica returned: <code>${esc(ids.filter(Boolean).join(", "))}</code></p>`,
            403,
          );
        }

        const { redirectTo } = await oauth.completeAuthorization({
          request: original,
          userId: user,
          metadata: { label: info.name ?? user },
          scope: original.scope,
          props: { user, name: info.name ?? user },
        });
        headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === "/") {
        return html(`<h1>LWA Lumber connector</h1><p>Add <code>${esc(url.origin)}/mcp</code> as a custom connector in Claude.</p>`);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const msg = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
        return html(`<h1>Sign-in couldn't continue</h1><p>${esc(String(msg ?? "The page expired. Start again from Claude."))}</p>`, 400);
      }
      throw error;
    }
  },
};
