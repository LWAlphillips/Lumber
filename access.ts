// Who may use the connector. Superadmins only for now: everyone on the list sees everything.
export function allowedUsers(env: Env): string[] {
  return (env.ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowed(env: Env, identities: (string | undefined)[]): boolean {
  const list = allowedUsers(env);
  return identities.some((id) => !!id && list.includes(id.toLowerCase()));
}
