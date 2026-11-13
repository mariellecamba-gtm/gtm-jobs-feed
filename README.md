# GTM Jobs Feed

**A free, public, continuously updated list of open GTM Engineer (Go-To-Market
Engineer), GTM Operations and GTM Strategy jobs across the US,
Europe and Australia.** Every role that appears becomes one GitHub issue in this
repo, so the
[issue list](https://github.com/mariellecamba-gtm/gtm-jobs-feed/issues) *is* the
job board. It updates itself every Monday and there is nothing to sign up for.

### 👉 [Browse the open GTM Engineer roles](https://github.com/mariellecamba-gtm/gtm-jobs-feed/issues)

**Want new roles emailed to you?** Click **Watch → Custom → Issues** at the top
of this page. GitHub then emails you every time a new job is filed. That is the
whole subscription mechanism, and it is free.

Roles are labelled by region (`region:US`, `region:EU`, `region:Australia`), by role type
(`role:GTM Engineer`, `role:GTM Operations`, `role:GTM Strategy`) and by company
size — both the original coarse bands
(`size:1-200`, `size:201+`) and the exact one (`size:11-50`, `size:1001-5000`,
…) — so you can filter to what you actually want. So far that is 258 US roles,
144 in Europe and 10 in Australia.

**Company size is not a filter.** A two-person startup and a 10,001+ employee
enterprise both get filed, as long as the posting is one of the three role
types. Size only changes which points of contact are listed.

## What is a GTM Engineer?

A GTM engineer builds and runs the technical systems a go-to-market team sells
with: outbound infrastructure, data enrichment and waterfalls, lead scoring,
CRM plumbing, deliverability, and the automations that connect them. The title
is new and unsettled, so postings also show up as **Go-To-Market Engineer**,
**Founding GTM Engineer** and **Senior GTM Engineer**.

This feed only files a posting whose title contains one of these exact phrases:

| Family | Title must contain | Example titles |
| --- | --- | --- |
| `GTM Engineer` | "GTM Engineer" or "Go-to-Market Engineer" | GTM Engineer, Founding GTM Engineer, Senior Go-To-Market Engineer |
| `GTM Operations` | "GTM Operations" or "Go-to-Market Operations" | GTM Operations Manager, Head of GTM Operations |
| `GTM Strategy` | "GTM Strategy" or "Go-to-Market Strategy" | GTM Strategy & Operations, Director, GTM Strategy |

Everything else is left out, even when it is close: Growth Engineer, Growth
Lead, GTM Systems Engineer, GTM Engineering Lead and GTM AI Engineer are not
filed.

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

Every **Monday at 06:00 UTC** an automated job searches for postings with one of
the three title families above, posted in the last seven days, in the US, Europe
and Australia. It drops recruiters and anything already filed (one issue per
company, ever) and opens one issue per new posting with the company, role,
location, posting date, a link to the original post, the company size band and up
to three points of contact. If a Monday run fails, it retries later that week and
looks back far enough to cover the gap.

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

GTM Engineer (including Go-to-Market Engineer), GTM Operations and GTM
Strategy, and nothing else (see the table above). Every issue carries a `role:*` label so
you can filter to one family.

### Does it only cover startups?

No. Every company size is in scope — the feed files a role from a five-person
seed startup and from a 10,001-person enterprise alike, as long as the title is
one of the three families. The `size:*` labels let you filter if you care.

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
