# GTM Jobs Feed

**A free, public, continuously updated list of open GTM Engineer (Go-To-Market
Engineer) jobs across the US, Europe, Australia and New Zealand.** Every role
that appears becomes one GitHub issue in this repo, so the
[issue list](https://github.com/mariellecamba-gtm/gtm-jobs-feed/issues) *is* the
job board. It updates itself every Monday and there is nothing to sign up for.

### 👉 [Browse the open GTM Engineer roles](https://github.com/mariellecamba-gtm/gtm-jobs-feed/issues)

**Want new roles emailed to you?** Click **Watch → Custom → Issues** at the top
of this page. GitHub then emails you every time a new job is filed. That is the
whole subscription mechanism, and it is free.

Roles are labelled by region (`region:US`, `region:EU`, `region:Australia`,
`region:New Zealand`) and by company size (`size:1-200`, `size:201+`), so you
can filter to what you actually want. So far that is 160 US roles, 86 in Europe
and 9 in Australia and New Zealand.

## What is a GTM Engineer?

A GTM engineer builds and runs the technical systems a go-to-market team sells
with: outbound infrastructure, data enrichment and waterfalls, lead scoring,
CRM plumbing, deliverability, and the automations that connect them. The title
is new and unsettled, so postings also show up as **Go-To-Market Engineer**,
**Founding GTM Engineer**, **GTM Systems Engineer**, **Growth Engineer** and
**RevOps Engineer**. This feed tracks the GTM Engineer variants specifically.

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
[`scripts/run.mjs`](scripts/run.mjs), which:

1. Searches the `professional-network-data` RapidAPI for the 2 titles × 4 regions.
2. Keeps only real GTM / Go-To-Market Engineer titles posted in the last 7 days.
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

United States, Europe, Australia and New Zealand. Each issue carries a
`region:US`, `region:EU`, `region:Australia` or `region:New Zealand` label.

### How do I get notified about new GTM Engineer jobs?

Click **Watch → Custom → Issues** at the top of this page. GitHub emails you each
new role as it is filed. Unwatch any time.

### Are these roles still open?

They were open when filed, and nothing closes an issue when a role gets filled,
so the list is cumulative. Each issue links the original posting, which is the
only reliable source of truth. Sort by newest for the roles most likely to still
be live.

### Can I submit a role?

Open an issue. The automation only searches two job titles across four regions,
so it misses things, and a role posted only on a company's own careers page will
never show up here.

### Why GitHub issues instead of a job board?

Because issues are free, searchable, labelled, RSS-able, emailable and permanent,
and because building an actual job board for this would be more work than the
feed is worth.

### Is there an RSS feed?

Yes, GitHub provides one:
`https://github.com/mariellecamba-gtm/gtm-jobs-feed/issues.atom`
