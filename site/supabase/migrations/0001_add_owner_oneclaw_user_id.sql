-- Applied for real against the live Supabase instance on 2026-09-30 (via psql,
-- SUPABASE_CONNECTION_STRING in ~/.secrets/verdict.env). No prior migrations directory
-- existed — the `deals` table itself was created directly via the dashboard/API, not tracked
-- here. This file exists so the real change is reproducible, not to be run by tooling yet.
--
-- Schema/type readiness for docs/designs/multi-tenant-1claw-wallets.md's per-user deal
-- ownership — nothing populates or enforces this column yet (see lib/deals.ts's comment on
-- DealMetadata.ownerOneclawUserId). Nullable and additive: existing rows are unaffected.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS owner_oneclaw_user_id text;
