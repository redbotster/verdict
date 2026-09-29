// Minimal REST (PostgREST) client for Supabase — plain fetch, not @supabase/supabase-js. This
// table has two operations (read a row, insert a row); the full SDK's realtime/auth/storage surface
// isn't needed, matching this repo's existing style for @verdict/imd-client and
// @verdict/oneclaw-client (hand-rolled clients over documented REST APIs).
//
// Server-only: SUPABASE_SERVICE_ROLE_KEY bypasses Row Level Security entirely, which is fine here
// because every caller of this module already runs on the server (Server Components, Server
// Actions, the resolve webhook) — there's no Supabase Auth in this app, so RLS policies keyed to a
// user session wouldn't apply anyway. The `deals` table itself has RLS enabled with zero policies,
// so the anon/public key (never used here) would see nothing.
function supabaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return url;
}

function supabaseKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return key;
}

async function supabaseFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const key = supabaseKey();
  return fetch(`${supabaseUrl()}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

export async function supabaseSelect<T>(table: string, query = ""): Promise<T[]> {
  const res = await supabaseFetch(`/${table}${query}`);
  if (!res.ok) throw new Error(`Supabase select on ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function supabaseInsert<T>(table: string, row: Record<string, unknown>): Promise<T> {
  const res = await supabaseFetch(`/${table}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase insert into ${table} failed: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as T[];
  return rows[0]!;
}
