# GTM Jobs Feed

Daily automated feed of **GTM Engineer / Go-To-Market Engineer** roles (US, EU, Australia, New Zealand).
Each new job post becomes a **GitHub issue** in this repo with the company's points of contact attached,
and those points of contact are pushed to an Aimfox campaign for LinkedIn connection requests.

Runs entirely on **GitHub Actions** — no servers, no Google Sheet. The code, the schedule, and the
output (issues) all live here.

## How it works

Every day at **06:00 UTC** ([`.github/workflows/daily.yml`](.github/workflows/daily.yml)) GitHub Actions runs
[`scripts/run.mjs`](scripts/run.mjs), which:

1. Searches the `professional-network-data` RapidAPI for the 2 titles × 4 regions.
2. Keeps only real GTM / Go-To-Market Engineer titles posted in the last 21 days.
3. Drops anything already filed — dedupes by **job id** and by **company** (one issue per company, ever)
   using [`state/seen.json`](state/seen.json), which the workflow commits back after each run.
4. For each new company, finds up to **3 points of contact** via Blitz **Waterfall ICP**
   (size-aware: ≤200 employees include CEO/Founder + Revenue + Growth; 201+ skip the CEO, focus
   Growth/GTM + Revenue).
5. **Opens a GitHub issue** for the job post with the points of contact listed (labels: `gtm-job`,
   `region:*`, `size:*`).
6. **Pushes those points of contact to Aimfox** (campaign `GTM Engineer Hiring — Decision Makers`),
   which sends LinkedIn connection requests from the `mariellecamba` account.

A safety cap (`MAX_ISSUES`, default 40) limits how many issues a single run can open.

## Setup (already done during migration)

**Actions secrets** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
| --- | --- |
| `RAPIDAPI_KEY` | RapidAPI key subscribed to `professional-network-data` |
| `BLITZ_API_KEY` | Blitz key for company-size enrichment + Waterfall ICP |
| `AIMFOX_API_KEY` | Aimfox API key (push is skipped if unset) |
| `AIMFOX_CAMPAIGN_ID` | Target Aimfox campaign id |

> All credentials live **only** in Actions secrets — never in the repo. `scripts/run.mjs` reads them
> from `process.env`; the workflow injects them via `${{ secrets.* }}`. Nothing sensitive is committed.

`GITHUB_TOKEN` is provided automatically by Actions and is what opens the issues / commits state.

The dedupe state was seeded from the legacy Google Sheet (133 companies, 134 job ids) via
[`scripts/seed-from-sheet.mjs`](scripts/seed-from-sheet.mjs) so nothing already processed gets re-filed.

## Run it manually

Actions tab → **GTM Jobs Feed** → **Run workflow** (toggle **Dry run** to preview without writing).

Locally:

```bash
RAPIDAPI_KEY=... BLITZ_API_KEY=... DRY_RUN=1 node scripts/run.mjs
```

## Migration notes

- Replaces the old Supabase edge function `fetch-gtm-jobs` (archived in
  [`legacy/`](legacy/supabase-edge-fetch-gtm-jobs.ts)) and its Google Sheet output.
- **The old Supabase cron `fetch-gtm-jobs-daily` should be disabled** so it stops writing to the sheet
  and double-running the Aimfox push.
- The Aimfox campaign is INIT — set the connection note/sequence and activate it in the Aimfox
  dashboard before invites send.
