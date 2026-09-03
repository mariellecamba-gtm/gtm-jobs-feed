// GTM Jobs Feed — GitHub-native runtime.
// Finds GTM Engineer / Go-To-Market Engineer / GTM Operations / Growth Engineer / Growth Lead roles
// (US, EU, AU) at companies of ANY size, opens ONE GitHub issue per new job post with its points
// of contact, and pushes those points of contact to an Aimfox campaign.
// Runs weekly on GitHub Actions (see .github/workflows/daily.yml). Node 20+, zero dependencies.
//
// Dedupe state lives in ../state/seen.json (committed back by the workflow) — one entry per job id
// AND one per company, so a company is never filed twice. This replaces the old Supabase table.
//
// Env: RAPIDAPI_KEY, BLITZ_API_KEY (required); AIMFOX_API_KEY, AIMFOX_CAMPAIGN_ID (optional — push
// is skipped if absent); GITHUB_TOKEN + GITHUB_REPOSITORY (auto-provided by Actions).
// Optional: RECENT_DAYS (default 7), MAX_ISSUES (safety cap, default 40), DRY_RUN=1 (no writes),
// MAX_REQUESTS (RapidAPI requests one run may spend, default 15 — see the budget note below).

import { readFile, writeFile } from "node:fs/promises";

const JOB_HOST = "professional-network-data.p.rapidapi.com";
const JOB_URL = `https://${JOB_HOST}/search-jobs-v2`;

const KEYWORDS = ["GTM Engineer", "Go To Market Engineer", "GTM Operations", "Growth Engineer", "Growth Lead"];
// New Zealand (105490917) was dropped 2026-08-27: it produced zero issues across the whole life of
// the feed while costing a quarter of every run's RapidAPI budget. Add it back as a TAIL_REGIONS
// entry to try again.
const LOCATIONS = { "US": "103644278", "EU": "91000000", "Australia": "101452733" };
// US and EU are searched for every keyword every run. Tail regions get only the budget left over
// afterwards and rotate week to week, so a run short on requests loses Australia, never Europe.
const CORE_REGIONS = ["US", "EU"];
const TAIL_REGIONS = ["Australia"];

// The four title families this feed tracks. A posting has to match one of them on the TITLE — the
// keyword search alone is relevance-ranked and happily returns "Growth Marketing Manager" for
// "Growth Lead". The family is recorded on the issue so the list stays filterable by role type.
const ROLE_FAMILIES = [
  { label: "GTM Engineer", re: /(gtm|go[-\s]*to[-\s]*market)[-\s]*(systems?[-\s]*|solutions?[-\s]*)?engineer/i },
  { label: "GTM Operations", re: /(gtm|go[-\s]*to[-\s]*market)[-\s]*(ops\b|operations)/i },
  { label: "Growth Engineer", re: /(growth[-\s]*(systems?[-\s]*|software[-\s]*|product[-\s]*)?engineer|\bengineer[,\s-]+growth\b)/i },
  { label: "Growth Lead", re: /(growth[-\s]*(team[-\s]*)?lead\b|\blead[,\s-]+growth\b)/i },
];
const titleFamily = (t) => ROLE_FAMILIES.find((f) => f.re.test(t ?? ""))?.label ?? "";

const BLITZ_ENRICH = "https://api.blitz-api.ai/v2/enrichment/company";
const BLITZ_WATERFALL = "https://api.blitz-api.ai/v2/search/waterfall-icp-keyword";
// Note: bare "sdr"/"bdr" are intentionally NOT excluded — they'd substring-match the wanted
// "SDR Manager"/"BDR Manager" titles. The rep-level phrases below still filter individual reps.
const DM_EXCLUDE = ["assistant", "intern", "executive business partner", "account executive",
  "sales development representative", "business development representative", "customer success", "recruiter", "talent", "coordinator", "student", "support"];
const dmTier = (titles) => ({ include_title: titles, exclude_title: DM_EXCLUDE, location: ["WORLD"], include_headline_search: false });
const T_CEO = dmTier(["CEO", "Chief Executive Officer", "Founder", "Co-Founder", "Owner", "President", "Managing Director"]);
const T_REV = dmTier(["CRO", "Chief Revenue Officer", "VP Sales", "VP of Sales", "Head of Sales", "Head of Revenue", "Chief Commercial Officer", "COO",
  "Director Sales", "Director of Sales", "Director Business Development", "Director of Business Development", "Head of Business Development", "BDR Manager", "SDR Manager"]);
const T_GROWTH = dmTier(["Head of Growth", "VP Growth", "Chief Growth Officer", "Head of GTM", "GTM Lead", "Go-to-Market", "CMO", "Chief Marketing Officer", "VP Marketing", "Head of Marketing", "Head of Demand Generation"]);
// At 1000+ employees the C-suite is unreachable and "Head of Growth" is often three people, so the
// enterprise cascade goes after the Director/VP layer that actually owns GTM systems instead.
const T_ENTERPRISE = dmTier(["Head of Growth", "VP Growth", "Director of Growth", "Head of GTM", "GTM Lead", "Director of Revenue Operations",
  "Head of Revenue Operations", "VP Revenue Operations", "Director of Sales Operations", "Head of Sales Operations", "Director of Demand Generation"]);
// Every band Blitz reports, smallest first — no size is excluded from the feed, the band only picks
// which decision-maker cascade to run and what the issue says.
const SIZE_BANDS = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"];
const SMALL_SIZES = new Set(["1-10", "11-50", "51-200"]);
const MID_SIZES = new Set(["201-500", "501-1000"]);
const ENTERPRISE_SIZES = new Set(["1001-5000", "5001-10000", "10001+"]);

const RECENT_DAYS = Number(process.env.RECENT_DAYS || 7);
const MAX_ISSUES = Number(process.env.MAX_ISSUES || 40);
// RapidAPI's plan is metered per request per month, not per run, so an unbounded grid plus retries
// can outrun a month's quota in three weeks and leave the feed dead until it resets. This is the
// hard ceiling on what one run may spend; pairs past it are skipped and named in the summary rather
// than silently dropped. The grid is 5 keywords x 3 regions = 15 pairs, which is exactly the
// default — 15 x 5 possible Mondays fits a 75/month plan, and retries eat into Australia first.
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS || 15);
const DRY_RUN = process.env.DRY_RUN === "1";
const TIMEOUT_MS = 25000, RETRIES = 4, SEARCH_CONCURRENCY = 2, DM_CONCURRENCY = 3;
// RapidAPI rate limits apply to the key, not to a single request, so bursting 4 searches at once
// used to trip a 429 on all of them at the same instant. Searches are now spaced apart and share
// one cooldown (see the rate gate below) instead of each burning its retries against a saturated limit.
const SEARCH_SPACING_MS = 500;
const RATE_BACKOFF_MS = [5000, 10000, 20000, 30000];

const SEEN_PATH = new URL("../state/seen.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tfetch = (url, init = {}, ms = TIMEOUT_MS) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

// ---- shared rate gate ----
// A 429 means the whole key is throttled, so one search tripping it holds every other search back
// for the same cooldown. Without this, concurrent searches each hit 429 and give up together.
let gateUntil = 0;
const openGate = (ms) => { gateUntil = Math.max(gateUntil, Date.now() + ms); };
async function waitGate() {
  for (let left = gateUntil - Date.now(); left > 0; left = gateUntil - Date.now()) await sleep(Math.min(left, 1000));
}
// Keeps request starts SEARCH_SPACING_MS apart so a burst never looks like a flood.
let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + SEARCH_SPACING_MS;
  if (slot > now) await sleep(slot - now);
}
// RapidAPI sends Retry-After on some 429s; honour it when it is sane, ignore it when it is not.
function retryAfterMs(r) {
  const h = r.headers.get("retry-after");
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, 60000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 60000) : 0;
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

// ---- dedupe state ----
async function loadSeen() {
  try {
    const j = JSON.parse(await readFile(SEEN_PATH, "utf8"));
    return {
      jobIds: new Set(j.jobIds || []),
      companies: new Set((j.companies || []).map((c) => c.toLowerCase())),
      lastOkRun: j.lastOkRun || "",
      quotaResetAt: j.quotaResetAt || "",
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

// ---- decision-maker discovery ----
// Maps a headcount onto the same bands Blitz reports, so a company that only exposes
// employees_on_linkedin still lands in a real band instead of "unknown".
function bandFromHeadcount(n) {
  if (!Number.isFinite(n)) return "";
  return n <= 10 ? "1-10" : n <= 50 ? "11-50" : n <= 200 ? "51-200" : n <= 500 ? "201-500"
    : n <= 1000 ? "501-1000" : n <= 5000 ? "1001-5000" : n <= 10000 ? "5001-10000" : "10001+";
}
// Size never decides whether a job is filed — every band is in scope as long as the title matches a
// role family. It only decides which decision-maker cascade has a chance of finding a real contact.
function sizeTier(band) {
  if (ENTERPRISE_SIZES.has(band)) return "enterprise";
  if (MID_SIZES.has(band)) return "mid";
  return "small"; // small bands and unknown both get the founder-first cascade
}
async function companySize(blitzKey, companyUrl) {
  try {
    const r = await tfetch(BLITZ_ENRICH, { method: "POST", headers: { "x-api-key": blitzKey, "Content-Type": "application/json" }, body: JSON.stringify({ company_linkedin_url: companyUrl }) }, 30000);
    const d = await r.json();
    const c = d?.found ? (d.company ?? {}) : {};
    if (c.size && SIZE_BANDS.includes(c.size)) return c.size;
    return bandFromHeadcount(c.employees_on_linkedin);
  } catch { return ""; }
}
async function findDecisionMakers(blitzKey, companyUrl, tier) {
  const cascade = tier === "enterprise" ? [T_ENTERPRISE, T_GROWTH, T_REV]
    : tier === "mid" ? [T_GROWTH, T_REV]
    : [T_CEO, T_REV, T_GROWTH];
  try {
    const r = await tfetch(BLITZ_WATERFALL, { method: "POST", headers: { "x-api-key": blitzKey, "Content-Type": "application/json" }, body: JSON.stringify({ company_linkedin_url: companyUrl, cascade, max_results: 3 }) }, 40000);
    const d = await r.json();
    const out = [], names = new Set();
    for (const item of (d?.results ?? [])) {
      const p = item.person ?? item;
      const url = p.linkedin_url, nm = (p.full_name ?? "").toLowerCase();
      if (url && !names.has(nm)) { names.add(nm); out.push({ profile_url: url, name: p.full_name, title: p.job_title || p.title || p.headline || "" }); }
    }
    return out;
  } catch { return []; }
}
async function pushToAimfox(aimfoxKey, campaignId, profiles) {
  let added = 0, failed = 0;
  const reasons = new Set();
  const url = `https://api.aimfox.com/api/v2/campaigns/${campaignId}/audience/multiple`;
  for (let i = 0; i < profiles.length; i += 10) {
    const chunk = profiles.slice(i, i + 10);
    const body = JSON.stringify({ type: "profile_url", profiles: chunk.map((p) => ({ profile_url: p.profile_url, custom_variables: { company: p.company } })) });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await tfetch(url, { method: "POST", headers: { Authorization: `Bearer ${aimfoxKey}`, "Content-Type": "application/json" }, body }, 90000);
        if (!r.ok) { reasons.add(`http${r.status}`); await sleep(1500); continue; }
        const d = await r.json().catch(() => ({}));
        added += (d?.profiles?.length ?? 0);
        failed += (d?.failed?.length ?? 0);
        for (const v of Object.values(d?.failedReason ?? {})) reasons.add(String(v));
        break;
      } catch { reasons.add("timeout"); await sleep(1500); }
    }
  }
  return { added, failed, note: `${added} added, ${failed} skipped` + (reasons.size ? ` (${[...reasons].slice(0, 4).join(",")})` : "") };
}

// Distinct 429 bodies seen this run, surfaced in the summary. RapidAPI answers a burst limit and
// an exhausted plan quota both with 429 but different text, and it can return both in one run, so
// keeping only the first message hides which one actually stopped the feed.
const rateLimitNotes = new Set();
// RapidAPI reports the plan window on every response. On a quota 429 it is the only thing that
// says when the feed can work again, so it goes in the summary instead of needing the dashboard.
let quotaState = "";
// ISO timestamp of the RapidAPI monthly reset, taken from the 429 headers. Persisted so the
// backup cron and later Mondays stand down instead of each burning another 15 requests on 429s.
let quotaResetAt = "";
// Once any search hears a monthly-quota 429, further pairs return immediately — a plan quota
// does not refill mid-run, so the rest of the grid would only spend the leftover budget on
// identical failures (this is how Aug 31 used 30 requests to learn the same -16/75 twice).
let quotaExhausted = false;
// Every RapidAPI call goes through searchJobs, so this is the run's exact spend against the
// monthly plan — the number that decides whether the schedule fits in the quota.
let apiRequests = 0;
function readQuota(r) {
  const limit = r.headers.get("x-ratelimit-requests-limit");
  const left = r.headers.get("x-ratelimit-requests-remaining");
  const reset = r.headers.get("x-ratelimit-requests-reset");
  if (!limit && !left && !reset) return "";
  const secs = Number(reset);
  if (Number.isFinite(secs) && secs > 0) {
    quotaResetAt = new Date(Date.now() + secs * 1000).toISOString();
  }
  const when = quotaResetAt
    ? `${Math.round(secs / 86400)}d (${quotaResetAt.slice(0, 16).replace("T", " ")}Z)`
    : (reset ?? "?");
  return `${left ?? "?"}/${limit ?? "?"} requests left, resets in ${when}`;
}

async function searchJobs(key, kw, geo) {
  let last = "empty";
  let rateHits = 0;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    // Reserve the request before awaiting anything, or two concurrent searches both pass the
    // check on the last unit of budget and the run overspends by SEARCH_CONCURRENCY.
    if (quotaExhausted) return { jobs: [], status: "budget" };
    if (apiRequests >= MAX_REQUESTS) return { jobs: [], status: attempt === 0 ? "budget" : last };
    apiRequests++;
    await waitGate();
    await pace();
    try {
      const qs = new URLSearchParams({ keywords: kw, locationId: geo });
      const r = await tfetch(`${JOB_URL}?${qs}`, { headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": JOB_HOST } });
      if (r.status === 429) {
        const msg = (await r.text().catch(() => "")).slice(0, 200);
        if (rateLimitNotes.size < 4) rateLimitNotes.add(msg || "(no body)");
        quotaState = readQuota(r) || quotaState;
        // A plan quota does not refill on a timescale this run can wait out — stop the whole
        // grid immediately rather than spending the leftover budget on identical 429s.
        if (/quota/i.test(msg)) {
          quotaExhausted = true;
          return { jobs: [], status: "quota" };
        }
        const wait = retryAfterMs(r) || RATE_BACKOFF_MS[Math.min(rateHits, RATE_BACKOFF_MS.length - 1)];
        rateHits++;
        last = "http429";
        openGate(wait);
        continue;
      }
      if (!r.ok) { last = `http${r.status}`; await sleep(900 * (attempt + 1)); continue; }
      const j = await r.json();
      if (Array.isArray(j?.data) && j.data.length) return { jobs: j.data, status: "ok" };
      // A well-formed empty result is the API's answer, not a glitch. Retrying it three more times
      // spends three more requests to be told the same thing — on a 75/month plan a quiet region
      // like NZ was burning 4 requests a run to report the zero jobs it reported on the first.
      if (Array.isArray(j?.data)) return { jobs: [], status: "empty" };
      last = j?.success === false ? "transient" : "malformed";
    } catch { last = "timeout"; }
    await sleep(900 * (attempt + 1));
  }
  return { jobs: [], status: last };
}

// Coarse size labels are kept as-is so links and saved filters from the first 255 issues still work;
// the exact band lives in the issue body.
function issueLabels(it) {
  const labels = ["gtm-job", `region:${it.region}`];
  // An unknown headcount is labelled as such rather than assumed small — the small cascade is a
  // safe default for finding contacts, but "size:1-200" on the issue would be a claim, not a guess.
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
  lines.push(`### Points of contact (${it.dms.length})`);
  if (it.dms.length) {
    for (const d of it.dms) lines.push(`- [${d.name}](${d.profile_url})${d.title ? ` — ${d.title}` : ""}`);
    lines.push("");
    lines.push(it.aimfoxQueued
      ? `_Queued to Aimfox campaign for LinkedIn connection requests._`
      : `_Aimfox push not configured — work these manually._`);
  } else {
    lines.push("_No points of contact found by the waterfall search._");
  }
  lines.push("");
  lines.push(`<!-- gtm-jobs-feed job_id=${it.jobId} -->`);
  return lines.join("\n");
}

// The search grid, ordered by expected yield so the request budget always buys US + EU coverage for
// every keyword first. AU/NZ take the remainder and rotate by week, so over consecutive runs every
// keyword still gets searched there — just not all of them in the same week.
function buildPairs(weekIndex) {
  const core = [], tail = [];
  for (const kw of KEYWORDS) {
    for (const region of CORE_REGIONS) core.push({ kw, region });
    for (const region of TAIL_REGIONS) tail.push({ kw, region });
  }
  const slice = Math.max(1, MAX_REQUESTS - core.length);
  const offset = tail.length ? (weekIndex * slice) % tail.length : 0;
  return [...core, ...tail.slice(offset), ...tail.slice(0, offset)];
}

async function main() {
  const secrets = {
    RAPIDAPI_KEY: process.env.RAPIDAPI_KEY,
    BLITZ_API_KEY: process.env.BLITZ_API_KEY,
    AIMFOX_API_KEY: process.env.AIMFOX_API_KEY,
    AIMFOX_CAMPAIGN_ID: process.env.AIMFOX_CAMPAIGN_ID,
  };
  if (!secrets.RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY missing");
  const seen = await loadSeen();
  const today = new Date().toISOString().slice(0, 10);

  // The 14:00 Monday schedule exists only to cover a 06:00 run that never got a runner. When the
  // primary already fetched today, a second full search grid re-learns the same thing for another
  // 8 requests — on a 75/month plan that duplicate is the difference between fitting and not.
  // Manual dispatches are never skipped, so a forced re-run still works.
  if (process.env.GITHUB_EVENT_NAME === "schedule" && seen.lastOkRun === today) {
    console.log(`skipped: a scheduled run already fetched successfully today (${today}) — 0 API requests made`);
    return;
  }

  // A monthly-quota 429 cannot be retried until RapidAPI resets the plan. Persist the reset
  // instant and stand the remaining Mondays down, otherwise each one spends MAX_REQUESTS to
  // hear the same 429 (Aug 31 burned 30 requests this way after the plan was already at -16/75).
  const quotaUntil = Date.parse(seen.quotaResetAt || "");
  if (process.env.GITHUB_EVENT_NAME === "schedule" && Number.isFinite(quotaUntil) && Date.now() < quotaUntil) {
    console.log(`skipped: RapidAPI monthly quota resets ${seen.quotaResetAt} — 0 API requests made`);
    return;
  }

  const cutoff = Date.now() - RECENT_DAYS * 86400_000;

  // 1) search
  const pairs = buildPairs(Math.floor(Date.now() / (7 * 86400_000)));
  const results = await mapPool(pairs, SEARCH_CONCURRENCY, async (p) => {
    const res = await searchJobs(secrets.RAPIDAPI_KEY, p.kw, LOCATIONS[p.region]);
    for (const j of res.jobs) j._region = p.region;
    return res;
  });
  const okSearches = results.filter((r) => r.status === "ok").length;
  const fails = {};
  for (const r of results) if (r.status !== "ok" && r.status !== "budget") fails[r.status] = (fails[r.status] ?? 0) + 1;
  // A pair the budget never paid for is not a failure, but it is coverage this run did not have —
  // name it, so "no Growth Lead jobs in NZ" is never confused with "we did not look".
  const skipped = pairs.filter((_, i) => results[i].status === "budget").map((p) => `${p.kw}/${p.region}`);
  const attempted = pairs.length - skipped.length;

  // 2) filter + dedupe
  let fetched = 0;
  const fresh = new Map();
  for (const { jobs } of results) {
    fetched += jobs.length;
    for (const j of jobs) {
      const jid = String(j?.id ?? "");
      if (!jid || fresh.has(jid)) continue;
      if (!titleFamily(j.title)) continue;
      if ((j.postedTimestamp ?? 0) < cutoff) continue;
      fresh.set(jid, j);
    }
  }
  const matched = fresh.size;

  const items = [];
  for (const [jid, j] of fresh) {
    if (seen.jobIds.has(jid)) continue;
    const cu = canonCompanyUrl(j?.company?.url);
    const ckey = companyKeyOf(cu, j.company?.name);
    if (!ckey || seen.companies.has(ckey)) continue;
    seen.companies.add(ckey); // guard against same-run dupes; persisted only after issue succeeds
    items.push({
      jobId: jid, companyKey: ckey, companyUrl: cu, companyName: j.company?.name ?? "(unknown)",
      title: j.title ?? "GTM Engineer", family: titleFamily(j.title), location: j.location ?? "", region: j._region ?? "",
      posted: j.postedTimestamp ? new Date(j.postedTimestamp).toISOString().slice(0, 10) : "",
      jobUrl: j.url ?? "", size: "", tier: "small", dms: [], aimfoxQueued: false,
    });
  }
  // reset same-run company guard so we only persist truly-filed companies below
  for (const it of items) seen.companies.delete(it.companyKey);

  let capped = 0;
  if (items.length > MAX_ISSUES) { capped = items.length - MAX_ISSUES; items.length = MAX_ISSUES; }

  // 3) decision-makers per company
  const useAimfox = !!(secrets.BLITZ_API_KEY && secrets.AIMFOX_API_KEY && secrets.AIMFOX_CAMPAIGN_ID);
  if (secrets.BLITZ_API_KEY) {
    await mapPool(items, DM_CONCURRENCY, async (it) => {
      if (!it.companyUrl) return;
      it.size = await companySize(secrets.BLITZ_API_KEY, it.companyUrl);
      it.tier = sizeTier(it.size);
      it.dms = await findDecisionMakers(secrets.BLITZ_API_KEY, it.companyUrl, it.tier);
      it.aimfoxQueued = useAimfox && it.dms.length > 0;
    });
  }

  // 4) create issues (sequential for clean ordering + rate safety); mark seen only on success
  let issuesCreated = 0;
  const issueErrors = [];
  const dmProfiles = [];
  for (const it of items) {
    try {
      if (DRY_RUN) { console.log(`[dry-run] issue: ${it.companyName} — ${it.title} (${it.dms.length} DMs)`); }
      else { const n = await createIssue({ title: `${it.companyName} — ${it.title} · ${it.region}`, body: issueBody(it), labels: issueLabels(it) }); console.log(`#${n} ${it.companyName}`); }
      issuesCreated++;
      seen.jobIds.add(it.jobId);
      seen.companies.add(it.companyKey);
      for (const d of it.dms) dmProfiles.push({ profile_url: d.profile_url, company: it.companyName });
    } catch (e) { issueErrors.push(`${it.companyName}: ${e.message || e}`); }
  }

  // 5) push decision-makers to Aimfox
  let dmDiag = "aimfox: skipped";
  if (useAimfox && dmProfiles.length && !DRY_RUN) {
    const res = await pushToAimfox(secrets.AIMFOX_API_KEY, secrets.AIMFOX_CAMPAIGN_ID, dmProfiles);
    dmDiag = `aimfox: ${dmProfiles.length} sent, ${res.note}`;
  } else if (useAimfox && DRY_RUN) {
    dmDiag = `aimfox: would push ${dmProfiles.length}`;
  } else if (!useAimfox) {
    dmDiag = `aimfox: not configured (${dmProfiles.length} DMs in issues only)`;
  }

  // 6) persist dedupe state — recording today only when searches actually returned, so a
  // rate-limited primary still leaves the backup run free to try again. A monthly-quota
  // 429 is the opposite: later runs must not retry until the plan resets.
  if (okSearches > 0) {
    seen.lastOkRun = today;
    seen.quotaResetAt = "";
  } else if (quotaResetAt) {
    seen.quotaResetAt = quotaResetAt;
  }
  await saveSeen(seen);

  const summary = [
    `fetched=${fetched} matched=${matched} new=${items.length} issues=${issuesCreated}` + (capped ? ` capped=${capped}` : ""),
    `requests=${apiRequests} (rapidapi)`,
    `searches ok=${okSearches}/${attempted}` + (Object.keys(fails).length ? ` fails=${JSON.stringify(fails)}` : ""),
    skipped.length ? `budget: ${apiRequests}/${MAX_REQUESTS} requests spent, ${skipped.length} pair(s) not searched: ${skipped.join(", ")}` : "",
    rateLimitNotes.size ? `rapidapi 429 said: ${[...rateLimitNotes].join(" | ")}` : "",
    quotaState ? `rapidapi plan: ${quotaState}` : "",
    dmDiag,
    issueErrors.length ? `issue errors: ${issueErrors.slice(0, 5).join(" | ")}` : "",
  ].filter(Boolean).join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY && !DRY_RUN) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `### GTM Jobs Feed\n\n\`\`\`\n${summary}\n\`\`\`\n`, { flag: "a" });
  }

  // A run that fetched nothing is a failed run, not a quiet one. Exiting 0 here is what let three
  // separate weeks of total rate-limiting show up as a green check with no jobs filed.
  if (attempted && okSearches === 0) {
    if (fails.quota) {
      console.error(`::error::RapidAPI monthly quota exhausted until ${seen.quotaResetAt || "the plan reset"} — no jobs were fetched`);
    } else {
      console.error(`::error::every search failed (${JSON.stringify(fails)}) — no jobs were fetched`);
    }
    process.exitCode = 1;
  } else if (okSearches < attempted) {
    console.warn(`::warning::${attempted - okSearches}/${attempted} searches failed — this run saw only part of the feed`);
  }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
