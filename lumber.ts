// Minimal read-only LumberFi API client. Only GET requests are possible from here.
const TOKEN_KEY = "lumber:access_token";

async function login(env: Env): Promise<string> {
  const res = await fetch(`${env.LUMBER_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: {
      "Api-Key": env.LUMBER_API_KEY,
      "Api-Secret": env.LUMBER_API_SECRET,
      "User-Id": env.LUMBER_USER_ID,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Lumber login failed (${res.status}). Check the LUMBER_* secrets in Cloudflare.`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Lumber login returned no access token.");
  // Token lifetime isn't documented; cache briefly and re-login on any 401.
  await env.OAUTH_KV.put(TOKEN_KEY, body.access_token, { expirationTtl: 1800 });
  return body.access_token;
}

async function token(env: Env, fresh = false): Promise<string> {
  if (!fresh) {
    const cached = await env.OAUTH_KV.get(TOKEN_KEY);
    if (cached) return cached;
  }
  return login(env);
}

export type Query = [string, string][];

export async function lumberGet<T>(env: Env, path: string, query: Query = []): Promise<T> {
  const qs = new URLSearchParams(query).toString();
  const url = `${env.LUMBER_BASE_URL}/api/v1/companies/${env.LUMBER_COMPANY_ID}${path}${qs ? "?" + qs : ""}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await token(env, attempt > 0)}`,
        "Api-Key": env.LUMBER_API_KEY,
        "Api-Secret": env.LUMBER_API_SECRET,
        "User-Id": env.LUMBER_USER_ID,
        Accept: "application/json",
      },
    });
    if (res.status === 401 && attempt === 0) continue; // expired token: log in again once
    if (res.status === 403) throw new Error("Lumber refused access (403). The API user may lack permission for this data.");
    if (res.status === 404) throw new Error("Lumber returned 404. Check LUMBER_COMPANY_ID.");
    if (!res.ok) throw new Error(`Lumber API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
  throw new Error("Lumber authentication failed after retry.");
}

type Page<T> = { data: T[]; total_records?: number; total_pages?: number };

/** Fetch every page of a list endpoint (capped to protect the Worker). */
export async function lumberGetAll<T>(env: Env, path: string, query: Query, maxPages = 25): Promise<{ rows: T[]; capped: boolean }> {
  const rows: T[] = [];
  let page = 0;
  let totalPages = 1;
  do {
    const res = await lumberGet<Page<T>>(env, path, [...query, ["page_size", "1000"], ["page_no", String(page)]]);
    rows.push(...(res.data ?? []));
    totalPages = res.total_pages ?? 1;
    page++;
  } while (page < totalPages && page < maxPages);
  return { rows, capped: page < totalPages };
}
