# Backend (InsForge) — Dashboard APBD NTB

This document describes the InsForge backend for the dashboard and the exact
steps to take it live. It implements the PRD (§5 architecture, §6 schema):
public read-only dashboard + admin-gated data import + AI recommendations.

---

## ⚠️ One blocker first: network policy

This Claude-on-the-web environment's **network policy blocks `*.insforge.dev`
and `*.insforge.app`** (the egress proxy returns `403 host_not_allowed`). That
means **from inside this session I cannot** run `insforge login`, `link`,
`db migrations up`, `functions deploy`, or have the frontend reach the backend.

Everything below is **built and verified offline** and is ready to apply. To go
live, run it from an environment where InsForge is reachable — either:

- **Recreate this web environment** choosing a network policy that allows
  `insforge.dev` and `insforge.app` (and optionally `us.i.posthog.com` for CLI
  telemetry). See https://code.claude.com/docs/en/claude-code-on-the-web , or
- Run the commands from your **local machine** (the CLI + files are in this repo).

The project is `8e32dd86-05ff-444e-852e-4f16abe0dad6`. The CLI **user API key**
was provided privately — keep it secret (do not commit it). Pass it at login
time via `--user-api-key <key>` or the `INSFORGE_ACCESS_TOKEN` env var.

---

## What's in the repo

```
migrations/20260626073700_init-apbd-schema.sql   # all tables + RLS + region seed
scripts/lib/parse-statements.mjs                 # BPK .xlsx (6 sheets) -> normalized records (verified)
scripts/seed-from-xlsx.mjs                        # CLI: xlsx -> idempotent seed SQL
data/samples/Kabupaten_Bima_2025.xlsx            # the provided audited file
data/seed/bima-2025.sql                           # generated seed for Kab. Bima TA 2025
functions/import-report/index.ts                  # admin-only: parse upload -> upsert -> recommendations
functions/generate-recommendations/index.ts       # admin-only: re-run AI analysis
web/insforge-client.js                            # browser SDK: auth + data hydration + import
insforge-config.js                                # frontend connection (fill baseUrl + anonKey)
.env.example                                       # server secrets reference
.claude/skills/insforge*                           # InsForge agent skills (installed)
```

## Database schema (PRD §6 + one extension)

`region`, `budget_entry`, `yearly_summary`, `indicator_data`, `ratio_result`,
`recommendation`, `upload_log`, `app_admin`, plus **`statement_line`** — the
extension that stores the 6 raw audited statements (LRA, LPSAL, Neraca, LO, LAK,
LPE) exactly as the uploaded `.xlsx`, so the "Laporan Keuangan" view and the
side-by-side comparison render straight from the database.

**RLS:** every dashboard table is `public read` (anon + authenticated). Writes
are revoked from runtime roles and happen only through the import edge function
using the admin API key. `app_admin` is the allowlist of users allowed to import.

## Data flow (matches PRD)

```
Admin login (InsForge Auth) ─▶ upload .xlsx ─▶ Storage (reports bucket)
                                     │
                                     ▼
                       import-report edge function
                  (verify admin → SheetJS parse → upsert
                   statement_line / yearly_summary / ratio_result /
                   indicator_data / budget_entry / upload_log)
                                     │
                                     ▼
                 OpenRouter (AI recommendations) → recommendation
                                     │
Public dashboard ◀── anon SELECT (RLS) ── all tables
```

---

## Go-live runbook

```bash
# 0) from the repo root, with InsForge reachable
npx @insforge/cli login --user-api-key <YOUR_USER_API_KEY>   # keep this secret
npx @insforge/cli link --project-id 8e32dd86-05ff-444e-852e-4f16abe0dad6

# 1) apply the schema (creates tables, RLS, seeds the 11 regions)
npx @insforge/cli db migrations up --all

# 2) seed the audited Kab. Bima TA 2025 data (uses the generated SQL)
npx @insforge/cli db query "$(cat data/seed/bima-2025.sql)"
#   …or regenerate for any region/file:
#   node scripts/seed-from-xlsx.mjs path/to/file.xlsx --region <slug> --year 2025 --audited > out.sql
#   npx @insforge/cli db query "$(cat out.sql)"

# 3) storage bucket for uploaded reports
npx @insforge/cli storage create-bucket reports --public=false   # see `storage` help for exact flag

# 4) secrets the edge functions need
npx @insforge/cli secrets add INSFORGE_BASE_URL  https://<your-app>.us-east.insforge.app
npx @insforge/cli secrets add INSFORGE_API_KEY   <project admin/service key>
npx @insforge/cli ai setup            # writes OPENROUTER_API_KEY (or: secrets add OPENROUTER_API_KEY sk-or-...)

# 5) deploy the edge functions
npx @insforge/cli functions deploy import-report            --file functions/import-report/index.ts
npx @insforge/cli functions deploy generate-recommendations --file functions/generate-recommendations/index.ts

# 6) make yourself an admin (so the import gate passes)
#    sign up once in the app (or via auth), then:
npx @insforge/cli db query "INSERT INTO public.app_admin (user_id,email) SELECT id, email FROM auth.users WHERE email='you@bpk.go.id' ON CONFLICT DO NOTHING;"

# 7) point the frontend at the backend
#    edit insforge-config.js -> BASE_URL = oss_host, ANON_KEY = `npx @insforge/cli secrets get ANON_KEY`
#    then deploy the static site (optional):
npx @insforge/cli deployments deploy   # see deployments help; or host index.html anywhere
```

After step 7 the dashboard automatically switches from demo data to live
database data on load (KPIs, charts, rankings, Rasio tab, Laporan Keuangan, and
Rekomendasi all read from the DB). Years present in the DB populate the year
selector; regions/years without data gracefully fall back to demo values.

## How the frontend switches modes

`insforge-config.js` is the single switch. With `BASE_URL`/`ANON_KEY` empty the
dashboard runs entirely offline (deterministic demo data — what you see today).
Fill both and reload: `web/insforge-client.js` loads `@insforge/sdk`, hydrates a
cache from the DB, and the existing UI reads from it. Admin login uses InsForge
Auth; the import button uploads the `.xlsx` and invokes `import-report`.

## Verified offline

- Parser tested against the provided `Kabupaten_Bima.xlsx`: extracts the audited
  figures exactly (Pendapatan 2.060,94 M; Belanja 2.032,25 M; PAD 209,56 M;
  Transfer 1.825,06 M; serapan 99,02%) and all 6 statements (302 lines).
- `data/seed/bima-2025.sql` generated from that parse.
- Edge functions type-check (esbuild). Migration DDL reviewed (standard Postgres
  + InsForge RLS conventions).
- Frontend demo mode unchanged and regression-tested (all 6 views, dark mode,
  admin login/import animation, Laporan compare).
