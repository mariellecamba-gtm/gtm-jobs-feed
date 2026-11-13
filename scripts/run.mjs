// GTM Jobs Feed — GitHub-native runtime.
// Finds GTM Engineer / Go-To-Market Engineer / GTM Operations / GTM Strategy roles (exact titles only)
// (US, EU, AU) at companies of ANY size and opens ONE GitHub issue per new job post.
// Runs weekly on GitHub Actions (see .github/workflows/daily.yml). Node 20+, zero dependencies.
//
// Job search: Blitz POST /v2/jobs/search (free/unlimited on our plan).
// Company size: Blitz company enrich, used only for the size labels.
//
// Env: BLITZ_API_KEY (required); GITHUB_TOKEN + GITHUB_REPOSITORY (Actions).
// Optional: RECENT_DAYS (default 7), MAX_ISSUES (default 40), MAX_PAGES (default 20), DRY_RUN=1.

import { readFile, writeFile } from "node:fs/promises";

const BLITZ = "https://api.blitz-api.ai";
const BLITZ_JOBS_SEARCH = `${BLITZ}/v2/jobs/search`;
const BLITZ_ENRICH = `${BLITZ}/v2/enrichment/company`;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const HIRING_TITLES = [
  "GTM Engineer", "Go To Market Engineer", "Go-to-Market Engineer", "Go-To-Market Engineer",
  "GTM Operations", "Go-to-Market Operations", "GTM Strategy", "Go-to-Market Strategy",
];

// Only these exact phrases count. Blitz matches titles loosely, so every result is re-checked
// here: "GTM Systems Engineer", "GTM Engineering Lead" and all Growth titles are dropped.
const ROLE_FAMILIES = [
  { label: "GTM Engineer", re: /\b(gtm|go[-\s]*to[-\s]*market)([-\s]*\(gtm\))?[-\s]+engineers?\b/i },
  { label: "GTM Operations", re: /\b(gtm|go[-\s]*to[-\s]*market)([-\s]*\(gtm\))?[-\s]+operations\b/i },
  { label: "GTM Strategy", re: /\b(gtm|go[-\s]*to[-\s]*market)([-\s]*\(gtm\))?[-\s]+strategy\b/i },
];
const titleFamily = (t) => ROLE_FAMILIES.find((f) => f.re.test(t ?? ""))?.label ?? "";

// MAX_ISSUES caps a week, so the order decides which jobs get filed: GTM Engineer, then Ops, then Strategy.
const FAMILY_RANK = { "GTM Engineer": 0, "GTM Operations": 1, "GTM Strategy": 2 };
const jobRank = (title) => FAMILY_RANK[titleFamily(title)] ?? 9;

// Not buyers: recruiters and staffing firms posting for someone else, schools and coaches,
// and roles too junior or commission-only to signal a GTM build-out.
const NOISE_COMPANY_RE = /recruit|staffing|\btalent\b|headhunt|coaching|\bschool\b|\btutor/i;
const NOISE_TITLE_RE = /\bintern(ship)?\b|ambassador|performance[-\s]*based|equity[-\s]*(only|split)/i;

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "GB", "UK", "CH", "NO", "IS", "LI",
]);

const SIZE_BANDS = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"];
const SMALL_SIZES = new Set(["1-10", "11-50", "51-200"]);

let RECENT_DAYS = Number(process.env.RECENT_DAYS || 7);
const MAX_ISSUES = Number(process.env.MAX_ISSUES || 40);
const MAX_PAGES = Number(process.env.MAX_PAGES || 20);
const DRY_RUN = process.env.DRY_RUN === "1";
const TIMEOUT_MS = 25000, ENRICH_CONCURRENCY = 3;
const SEARCH_SPACING_MS = 500;

const SEEN_PATH = new URL("../state/seen.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tfetch = (url, init = {}, ms = TIMEOUT_MS) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
// Timeouts, 429s and 5xx are retried with backoff; any other status is returned to the caller.
// A timeout that survives every attempt throws, so callers decide whether it is fatal.
async function rfetch(url, init, ms, attempts = 3) {
  for (let a = 1; ; a++) {
    try {
      const r = await tfetch(url, init, ms);
      if ((r.status === 429 || r.status >= 500) && a < attempts) { await sleep(3000 * a); continue; }
      return r;
    } catch (e) {
      if (a >= attempts) throw e;
      await sleep(3000 * a);
    }
  }
}

let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + SEARCH_SPACING_MS;
  if (slot > now) await sleep(slot - now);
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
function canonCompanyUrl(u) {
  if (!u) return "";
  const m = String(u).match(/(https?:\/\/[^/]*linkedin\.com\/company\/[^/?#]+)/i);
  return m ? m[1] : "";
}
const companyKeyOf = (cu, name) => (cu || name || "").toLowerCase().trim();
function jobIdFrom(job) {
  if (job.id) return String(job.id);
  const m = String(job.url || "").match(/(\d{6,})\s*\/?$/);
  return m ? m[1] : "";
}
function regionFromJob(job) {
  const code = String(job?.location?.country_code || job?.location?.countryCode || "").toUpperCase();
  if (code === "US") return "US";
  if (code === "AU") return "Australia";
  if (EU_COUNTRIES.has(code)) return "EU";
  const loc = `${job?.location?.country || ""} ${job?.location?.city || ""} ${typeof job?.location === "string" ? job.location : ""}`.toLowerCase();
  if (/\bunited states\b|\busa\b/.test(loc)) return "US";
  if (/\baustralia\b/.test(loc)) return "Australia";
  if (/\bunited kingdom\b|\bengland\b|\bgermany\b|\bfrance\b|\bnetherlands\b|\bireland\b|\bspain\b|\bitaly\b|\bsweden\b|\bswitzerland\b|\bnorway\b|\bdenmark\b|\bpoland\b|\bbelgium\b|\bportugal\b|\bfinland\b|\baustria\b|\beurope\b/.test(loc)) return "EU";
  return "";
}
function locationText(job) {
  const loc = job?.location;
  if (!loc) return "";
  if (typeof loc === "string") return loc;
  return [loc.city, loc.country || loc.country_code].filter(Boolean).join(", ");
}
function postedTs(datePosted) {
  const t = Date.parse(datePosted || "");
  return Number.isFinite(t) ? t : 0;
}
function blitzHeaders(key) {
  return { "x-api-key": key, "Content-Type": "application/json", "User-Agent": BROWSER_UA };
}

// ---- dedupe state ----
async function loadSeen() {
  try {
    const j = JSON.parse(await readFile(SEEN_PATH, "utf8"));
    return {
      jobIds: new Set(j.jobIds || []),
      companies: new Set((j.companies || []).map((c) => c.toLowerCase())),
      lastOkRun: j.lastOkRun || "",
      quotaResetAt: "",
    };
  } catch { return { jobIds: new Set(), companies: new Set(), lastOkRun: "", quotaResetAt: "" }; }
}
async function saveSeen(seen) {
  const body = JSON.stringify({
    updatedAt: process.env.RUN_TIMESTAMP || "",
    lastOkRun: seen.lastOkRun || "",
    quotaResetAt: seen.quotaResetAt || "",
    jobIds: [...seen.jobIds].sort(),
    companies: [...seen.companies].sort(),
  }, null, 2);
  if (!DRY_RUN) await writeFile(SEEN_PATH, body + "\n");
}

// ---- GitHub issues ----
function ghRepo() {
  const r = process.env.GITHUB_REPOSITORY || "mariellecamba-gtm/gtm-jobs-feed";
  const [owner, repo] = r.split("/");
  return { owner, repo };
}
async function createIssue({ title, body, labels }) {
  const { owner, repo } = ghRepo();
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN missing");
  const r = await tfetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gtm-jobs-feed",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, labels }),
  }, 30000);
  if (!r.ok) throw new Error(`issue ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).number;
}

function bandFromHeadcount(n) {
  if (!Number.isFinite(n)) return "";
  return n <= 10 ? "1-10" : n <= 50 ? "11-50" : n <= 200 ? "51-200" : n <= 500 ? "201-500"
    : n <= 1000 ? "501-1000" : n <= 5000 ? "1001-5000" : n <= 10000 ? "5001-10000" : "10001+";
}

async function companySize(blitzKey, companyUrl) {
  if (!blitzKey || !companyUrl) return "";
  try {
    await pace();
    const r = await tfetch(BLITZ_ENRICH, { method: "POST", headers: blitzHeaders(blitzKey), body: JSON.stringify({ company_linkedin_url: companyUrl }) }, 30000);
    const d = await r.json();
    const c = d?.found ? (d.company ?? d) : (d.company ?? {});
    return SIZE_BANDS.includes(c.size) ? c.size : bandFromHeadcount(c.employees_on_linkedin);
  } catch { return ""; }
}

async function searchBlitzJobs(key) {
  const jobs = [];
  const seen = new Set();
  let pages = 0;
  let status = "ok";
  let lastError = "";
  let cursor = "";
  for (let p = 0; p < MAX_PAGES; p++) {
    await pace();
    const body = {
      job: {
        title: { include: HIRING_TITLES },
        date_posted: { last_days: Math.max(1, RECENT_DAYS) },
      },
      max_results: 50,
    };
    if (cursor) body.cursor = cursor;
    const r = await rfetch(BLITZ_JOBS_SEARCH, { method: "POST", headers: blitzHeaders(key), body: JSON.stringify(body) }, 45000)
      .catch((e) => ({ ok: false, status: e.name === "TimeoutError" ? "timeout" : "network" }));
    pages++;
    if (!r.ok) {
      status = "error";
      lastError = `http${r.status}`;
      break;
    }
    const j = await r.json();
    const batch = Array.isArray(j.results) ? j.results : [];
    for (const job of batch) {
      const id = jobIdFrom(job);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      jobs.push(job);
    }
    cursor = j.cursor || j.next_cursor || "";
    if (!cursor || !batch.length) break;
  }
  if (!jobs.length && status === "ok") status = "empty";
  return { jobs, pages, status, lastError };
}

function issueLabels(it) {
  const labels = ["gtm-job", `region:${it.region}`];
  labels.push(it.size ? (SMALL_SIZES.has(it.size) ? "size:1-200" : "size:201+") : "size:unknown");
  if (it.size) labels.push(`size:${it.size}`);
  if (it.family) labels.push(`role:${it.family}`);
  return labels;
}

function issueBody(it) {
  const lines = [];
  lines.push(`**Company:** ${it.companyUrl ? `[${it.companyName}](${it.companyUrl})` : it.companyName}`);
  lines.push(`**Role:** ${it.title}` + (it.family ? ` (${it.family})` : ""));
  lines.push(`**Location:** ${it.location} · ${it.region}`);
  if (it.posted) lines.push(`**Posted:** ${it.posted}`);
  if (it.jobUrl) lines.push(`**Job post:** ${it.jobUrl}`);
  lines.push(`**Company size:** ${it.size ? `${it.size} employees` : "unknown"}`);
  lines.push("");
  lines.push(`<!-- gtm-jobs-feed job_id=${it.jobId} -->`);
  return lines.join("\n");
}

async function main() {
  const BLITZ_API_KEY = process.env.BLITZ_API_KEY;
  if (!BLITZ_API_KEY) throw new Error("BLITZ_API_KEY missing");
  const seen = await loadSeen();
  const today = new Date().toISOString().slice(0, 10);

  // Monday has a primary and a backup cron, Tue-Fri a catch-up cron each. All of them stand
  // down once this week (Monday UTC onward) has a successful fetch, so a good Monday costs
  // 0 API requests for the rest of the week and a failed one is retried the next day.
  if (process.env.GITHUB_EVENT_NAME === "schedule") {
    const d = new Date();
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)))
      .toISOString().slice(0, 10);
    if (seen.lastOkRun && seen.lastOkRun >= monday) {
      console.log(`skipped: this week already fetched successfully (lastOkRun=${seen.lastOkRun}) — 0 API requests made`);
      return;
    }
    // Missed weeks: widen the lookback to reach back to the last good fetch (capped at 21 days).
    // Already-filed jobs and companies are skipped via seen.json, so the overlap is harmless.
    const since = seen.lastOkRun ? Math.ceil((Date.now() - Date.parse(seen.lastOkRun)) / 86400_000) + 1 : 0;
    if (since > RECENT_DAYS) {
      RECENT_DAYS = Math.min(21, since);
      console.log(`catch-up: last good fetch ${seen.lastOkRun}, looking back ${RECENT_DAYS} days`);
    }
  }

  const cutoff = Date.now() - RECENT_DAYS * 86400_000;
  const search = await searchBlitzJobs(BLITZ_API_KEY);

  let fetched = 0, noise = 0;
  const fresh = new Map();
  for (const j of search.jobs) {
    fetched++;
    const jid = jobIdFrom(j);
    if (!jid || fresh.has(jid)) continue;
    if (!titleFamily(j.title)) continue;
    if (NOISE_TITLE_RE.test(j.title || "") || NOISE_COMPANY_RE.test(j.company_name || j.company?.name || "")) { noise++; continue; }
    if (postedTs(j.date_posted) && postedTs(j.date_posted) < cutoff) continue;
    const region = regionFromJob(j);
    if (!region) continue;
    j._region = region;
    j._id = jid;
    fresh.set(jid, j);
  }

  // Rank before the per-company dedupe, so a company with two posts is filed under its best one.
  const ranked = [...fresh].sort(([, a], [, b]) =>
    jobRank(a.title) - jobRank(b.title) || postedTs(b.date_posted) - postedTs(a.date_posted));
  const items = [];
  for (const [jid, j] of ranked) {
    if (seen.jobIds.has(jid)) continue;
    const cu = canonCompanyUrl(j.company_linkedin_url || j.company?.linkedin_url || j.company?.url);
    const ckey = companyKeyOf(cu, j.company_name || j.company?.name);
    if (!ckey || seen.companies.has(ckey)) continue;
    seen.companies.add(ckey);
    items.push({
      jobId: jid, companyKey: ckey, companyUrl: cu,
      companyName: j.company_name || j.company?.name || "(unknown)",
      title: j.title ?? "GTM Engineer", family: titleFamily(j.title),
      location: locationText(j), region: j._region,
      posted: postedTs(j.date_posted) ? new Date(postedTs(j.date_posted)).toISOString().slice(0, 10) : (j.date_posted || ""),
      jobUrl: j.url || "", size: "",
    });
  }
  for (const it of items) seen.companies.delete(it.companyKey);
  const matched = items.length;

  let capped = 0;
  if (items.length > MAX_ISSUES) { capped = items.length - MAX_ISSUES; items.length = MAX_ISSUES; }

  await mapPool(items, ENRICH_CONCURRENCY, async (it) => { it.size = await companySize(BLITZ_API_KEY, it.companyUrl); });

  let issuesCreated = 0;
  const issueErrors = [];
  for (const it of items) {
    try {
      if (DRY_RUN) { console.log(`[dry-run] issue: ${it.companyName} — ${it.title} (${it.size || "size unknown"})`); }
      else { const n = await createIssue({ title: `${it.companyName} — ${it.title} · ${it.region}`, body: issueBody(it), labels: issueLabels(it) }); console.log(`#${n} ${it.companyName}`); }
      issuesCreated++;
      seen.jobIds.add(it.jobId);
      seen.companies.add(it.companyKey);
    } catch (e) { issueErrors.push(`${it.companyName}: ${e.message || e}`); }
  }

  if (search.status === "ok" || search.status === "empty") seen.lastOkRun = today;
  await saveSeen(seen);

  const summary = [
    `fetched=${fetched} matched=${matched} new=${items.length} issues=${issuesCreated}` + (capped ? ` capped=${capped}` : "") + ` noise_skipped=${noise}`,
    `requests=${search.pages} (blitz /v2/jobs/search)`,
    `searches ${search.status}` + (search.lastError ? ` error=${search.lastError}` : ""),
    issueErrors.length ? `issue errors: ${issueErrors.slice(0, 5).join(" | ")}` : "",
  ].filter(Boolean).join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY && !DRY_RUN) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `### GTM Jobs Feed\n\n\`\`\`\n${summary}\n\`\`\`\n`, { flag: "a" });
  }

  if (search.status === "error") {
    console.error(`::error::Blitz job search failed (${search.lastError || "unknown"}) — no jobs were fetched`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
