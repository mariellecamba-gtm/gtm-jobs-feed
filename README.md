# GTM Jobs Feed

**A free, public, continuously updated list of open GTM Engineer (Go-To-Market
Engineer), GTM Operations, Growth Engineer and Growth Lead jobs across the US,
Europe and Australia.** Every role that appears becomes one GitHub issue in this
repo, so the
[issue list](https://github.com/mariellecamba-gtm/gtm-jobs-feed/issues) *is* the
job board. It updates itself every Monday and there is nothing to sign up for.

### 👉 [Browse the open GTM Engineer roles](https://github.com/mariellecamba-gtm/gtm-jobs-feed/issues)

**Want new roles emailed to you?** Click **Watch → Custom → Issues** at the top
of this page. GitHub then emails you every time a new job is filed. That is the
whole subscription mechanism, and it is free.

Roles are labelled by region (`region:US`, `region:EU`, `region:Australia`), by role type
(`role:GTM Engineer`, `role:GTM Operations`, `role:Growth Engineer`,
`role:Growth Lead`) and by company size — both the original coarse bands
(`size:1-200`, `size:201+`) and the exact one (`size:11-50`, `size:1001-5000`,
…) — so you can filter to what you actually want. So far that is 160 US roles,
86 in Europe and 9 in Australia.

**Company size is not a filter.** A two-person startup and a 10,001+ employee
enterprise both get filed, as long as the posting is one of the four role
types. Size only changes who the feed looks for as a point of contact.

## What is a GTM Engineer?

A GTM engineer builds and runs the technical systems a go-to-market team sells
with: outbound infrastructure, data enrichment and waterfalls, lead scoring,
CRM plumbing, deliverability, and the automations that connect them. The title
is new and unsettled, so postings also show up as **Go-To-Market Engineer**,
**Founding GTM Engineer**, **GTM Systems Engineer**, **Growth Engineer** and
**RevOps Engineer**.

This feed tracks four title families, because the same job is advertised under
all of them:

| Family | Matches titles like |
| --- | --- |
| `GTM Engineer` | GTM Engineer, Go-To-Market Engineer, Founding GTM Engineer, GTM Systems Engineer |
| `GTM Operations` | GTM Operations Manager, Go-to-Market Operations Lead, GTM Ops Associate |
| `Growth Engineer` | Growth Engineer, Senior Growth Software Engineer, Software Engineer — Growth |
| `Growth Lead` | Growth Lead, Growth Team Lead, "Lead, Growth" |

Growth *marketing* titles (Growth Marketing Manager, Growth Marketer, Head of
Growth) are deliberately not matched — they are a different job.

It sits between sales, marketing and engineering, and it is one of the
fastest-growing job titles in B2B SaaS, which is why a dedicated feed for it is
worth keeping.

## Who is hiring GTM Engineers?

Whoever is in the [issue list](https://github.com/mariellecamba-gtm/gtm-jobs-feed/issues)
right now, which is 255 companies and counting. Every issue names the company,
the role, the region, the company size band, and links the original job post.

Issues are never closed automatically, so the list is cumulative rather than a
snapshot of what is live today. Treat the linked posting as the source of truth
for whether a role is still open, and sort by newest to see this week's.

---

## How it works

Every **Monday at 06:00 UTC** ([`.github/workflows/daily.yml`](.github/workflows/daily.yml)) GitHub Actions runs
[`scripts/run.mjs`](scripts/run.mjs) (with a 14:00 UTC backup if the morning run never fetched), which:

1. Searches the `professional-network-data` RapidAPI across the 5 keywords × 3 regions —
   15 requests, exactly the `MAX_REQUESTS` (default 15) per-run ceiling. US and EU are
   searched for every keyword; Australia gets whatever budget is left, so retries cost
   Australian coverage before European. Any pair the budget did not buy is named in the summary.
2. Keeps only titles matching one of the four role families above, posted in the last 7 days.
3. Drops anything already filed — dedupes by **job id** and by **company** (one issue per company, ever)
   using [`state/seen.json`](state/seen.json), which the workflow commits back after each run.
4. For each new company — **any size**, from 1 employee to 10,001+ — finds up to **3 points of
   contact** via Blitz **Waterfall ICP**, with the cascade chosen by headcount: ≤200 includes
   CEO/Founder + Revenue + Growth; 201–1000 skips the CEO for Growth/GTM + Revenue; 1001+ goes
   after the Director/VP layer that owns GTM systems (Growth, RevOps, Sales Ops, Demand Gen).
5. **Opens a GitHub issue** for the job post with the points of contact listed (labels: `gtm-job`,
   `region:*`, `size:*`, `role:*`).
6. **Pushes those points of contact to Aimfox** (campaign `GTM Engineer Hiring — Decision Makers`),
   which sends LinkedIn connection requests from the `mariellecamba` account.

A safety cap (`MAX_ISSUES`, default 40) limits how many issues a single run can open, and
`MAX_REQUESTS` (default 15) caps RapidAPI spend per run — 15 × 5 possible Mondays fits a
75-requests/month plan. If a run hits the monthly quota, the reset time is written to
`state/seen.json` and later scheduled runs stand down until then, so the backup cron does
not spend another 15 requests on the same 429. New Zealand was dropped in August 2026: it
had produced no roles at all across the life of the feed while costing a quarter of every
run's budget. Adding a region back is one entry in `TAIL_REGIONS`.

## Running your own copy

Fork it, point it at your own titles and regions, and it files its own issues.
You will need your own keys for the three services below, none of which are
free.

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

---

## Questions people actually ask

### Is this job feed free?

Yes. It is a public GitHub repo. No account, no email, no paywall. Watching the
repo for email alerts is free too.

### How often does it update?

Every Monday at 06:00 UTC. It looks back seven days, so nothing in that window
is missed.

### Which regions does it cover?

The United States, Europe and Australia. Each issue carries a `region:US`,
`region:EU` or `region:Australia` label. New Zealand was searched until August
2026 and dropped — it had never produced a single role, for a quarter of the
search budget.

### How do I get notified about new GTM Engineer jobs?

Click **Watch → Custom → Issues** at the top of this page. GitHub emails you each
new role as it is filed. Unwatch any time.

### Are these roles still open?

They were open when filed, and nothing closes an issue when a role gets filled,
so the list is cumulative. Each issue links the original posting, which is the
only reliable source of truth. Sort by newest for the roles most likely to still
be live.

### Which job titles does it cover?

GTM Engineer, GTM Operations, Growth Engineer and Growth Lead, plus the common
variants of each (see the table above). Every issue carries a `role:*` label so
you can filter to one family.

### Does it only cover startups?

No. Every company size is in scope — the feed files a role from a five-person
seed startup and from a 10,001-person enterprise alike, as long as the title is
one of the four families. The `size:*` labels let you filter if you care.

### Can I submit a role?

Open an issue. The automation only searches five keywords across three regions,
so it misses things, and a role posted only on a company's own careers page will
never show up here.

### Why GitHub issues instead of a job board?

Because issues are free, searchable, labelled, RSS-able, emailable and permanent,
and because building an actual job board for this would be more work than the
feed is worth.

### Is there an RSS feed?

Yes, GitHub provides one:
`https://github.com/mariellecamba-gtm/gtm-jobs-feed/issues.atom`
