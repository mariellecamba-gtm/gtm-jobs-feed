// GTM Jobs Feed — GitHub-native runtime.
// Finds GTM Engineer / Go-To-Market Engineer roles (US, EU, AU, NZ), opens ONE GitHub issue
// per new job post with its points of contact, and pushes those points of contact to an Aimfox campaign.
// Runs weekly on GitHub Actions (see .github/workflows/daily.yml). Node 20+, zero dependencies.
//
// Dedupe state lives in ../state/seen.json (committed back by the workflow) — one entry per job id
// AND one per company, so a company is never filed twice. This replaces the old Supabase table.
//
// Env: RAPIDAPI_KEY, BLITZ_API_KEY (required); AIMFOX_API_KEY, AIMFOX_CAMPAIGN_ID (optional — push
// is skipped if absent); GITHUB_TOKEN + GITHUB_REPOSITORY (auto-provided by Actions).
// Optional: RECENT_DAYS (default 7), MAX_ISSUES (safety cap, default 40), DRY_RUN=1 (no writes).

import { readFile, writeFile } from "node:fs/promises";

const JOB_HOST = "professional-network-data.p.rapidapi.com";
const JOB_URL = `https://${JOB_HOST}/search-jobs-v2`;

const KEYWORDS = ["GTM Engineer", "Go To Market Engineer"];
const LOCATIONS = { "US": "103644278", "EU": "91000000", "Australia": "101452733", "New Zealand": "105490917" };
const TITLE_ALLOW = /(gtm\s*engineer|go[-\s]*to[-\s]*market\s*engineer)/i;

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
const LARGE_SIZES = new Set(["201-500", "501-1000", "1001-5000", "5001-10000", "10001+"]);
const SMALL_SIZES = new Set(["1-10", "11-50", "51-200"]);

const RECENT_DAYS = Number(process.env.RECENT_DAYS || 7);
const MAX_ISSUES = Number(process.env.MAX_ISSUES || 40);
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
    return { jobIds: new Set(j.jobIds || []), companies: new Set((j.companies || []).map((c) => c.toLowerCase())), lastOkRun: j.lastOkRun || "" };
  } catch { return { jobIds: new Set(), companies: new Set(), lastOkRun: "" }; }
}
async function saveSeen(seen) {
  const body = JSON.stringify({
    updatedAt: process.env.RUN_TIMESTAMP || "",
    lastOkRun: seen.lastOkRun || "",
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
async function companyIsLarge(blitzKey, companyUrl) {
  try {
    const r = await tfetch(BLITZ_ENRICH, { method: "POST", headers: { "x-api-key": blitzKey, "Content-Type": "application/json" }, body: JSON.stringify({ company_linkedin_url: companyUrl }) }, 30000);
    const d = await r.json();
    const c = d?.found ? (d.company ?? {}) : {};
    if (c.size && LARGE_SIZES.has(c.size)) return true;
    if (c.size && SMALL_SIZES.has(c.size)) return false;
    if (typeof c.employees_on_linkedin === "number") return c.employees_on_linkedin > 200;
  } catch { /* default small */ }
  return false;
}
async function findDecisionMakers(blitzKey, companyUrl, large) {
  const cascade = large ? [T_GROWTH, T_REV] : [T_CEO, T_REV, T_GROWTH];
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
// Every RapidAPI call goes through searchJobs, so this is the run's exact spend against the
// monthly plan — the number that decides whether the schedule fits in the quota.
let apiRequests = 0;
function readQuota(r) {
  const limit = r.headers.get("x-ratelimit-requests-limit");
  const left = r.headers.get("x-ratelimit-requests-remaining");
  const reset = r.headers.get("x-ratelimit-requests-reset");
  if (!limit && !left && !reset) return "";
  const secs = Number(reset);
  const when = Number.isFinite(secs) && secs > 0
    ? `${Math.round(secs / 86400)}d (${new Date(Date.now() + secs * 1000).toISOString().slice(0, 16).replace("T", " ")}Z)`
    : (reset ?? "?");
  return `${left ?? "?"}/${limit ?? "?"} requests left, resets in ${when}`;
}

async function searchJobs(key, kw, geo) {
  let last = "empty";
  let rateHits = 0;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    await waitGate();
    await pace();
    try {
      const qs = new URLSearchParams({ keywords: kw, locationId: geo });
      apiRequests++;
      const r = await tfetch(`${JOB_URL}?${qs}`, { headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": JOB_HOST } });
      if (r.status === 429) {
        const msg = (await r.text().catch(() => "")).slice(0, 200);
        if (rateLimitNotes.size < 4) rateLimitNotes.add(msg || "(no body)");
        quotaState = readQuota(r) || quotaState;
        // A plan quota does not refill on a timescale this run can wait out — stop immediately
        // rather than spending the job's remaining minutes on retries that cannot succeed.
        if (/quota/i.test(msg)) return { jobs: [], status: "quota" };
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

function issueBody(it) {
  const lines = [];
  lines.push(`**Company:** ${it.companyUrl ? `[${it.companyName}](${it.companyUrl})` : it.companyName}`);
  lines.push(`**Role:** ${it.title}`);
  lines.push(`**Location:** ${it.location} · ${it.region}`);
  if (it.posted) lines.push(`**Posted:** ${it.posted}`);
  if (it.jobUrl) lines.push(`**Job post:** ${it.jobUrl}`);
  lines.push(`**Company size:** ${it.large ? "201+ employees" : "≤200 employees"}`);
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

  const cutoff = Date.now() - RECENT_DAYS * 86400_000;

  // 1) search
  const pairs = [];
  for (const kw of KEYWORDS) for (const region of Object.keys(LOCATIONS)) pairs.push({ kw, region });
  const results = await mapPool(pairs, SEARCH_CONCURRENCY, async (p) => {
    const res = await searchJobs(secrets.RAPIDAPI_KEY, p.kw, LOCATIONS[p.region]);
    for (const j of res.jobs) j._region = p.region;
    return res;
  });
  const okSearches = results.filter((r) => r.status === "ok").length;
  const fails = {};
  for (const r of results) if (r.status !== "ok") fails[r.status] = (fails[r.status] ?? 0) + 1;

  // 2) filter + dedupe
  let fetched = 0;
  const fresh = new Map();
  for (const { jobs } of results) {
    fetched += jobs.length;
    for (const j of jobs) {
      const jid = String(j?.id ?? "");
      if (!jid || fresh.has(jid)) continue;
      if (!TITLE_ALLOW.test(j.title ?? "")) continue;
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
      title: j.title ?? "GTM Engineer", location: j.location ?? "", region: j._region ?? "",
      posted: j.postedTimestamp ? new Date(j.postedTimestamp).toISOString().slice(0, 10) : "",
      jobUrl: j.url ?? "", large: false, dms: [], aimfoxQueued: false,
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
      it.large = await companyIsLarge(secrets.BLITZ_API_KEY, it.companyUrl);
      it.dms = await findDecisionMakers(secrets.BLITZ_API_KEY, it.companyUrl, it.large);
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
      else { const n = await createIssue({ title: `${it.companyName} — ${it.title} · ${it.region}`, body: issueBody(it), labels: ["gtm-job", `region:${it.region}`, it.large ? "size:201+" : "size:1-200"] }); console.log(`#${n} ${it.companyName}`); }
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
  // rate-limited primary still leaves the backup run free to try again.
  if (okSearches > 0) seen.lastOkRun = today;
  await saveSeen(seen);

  const summary = [
    `fetched=${fetched} matched=${matched} new=${items.length} issues=${issuesCreated}` + (capped ? ` capped=${capped}` : ""),
    `requests=${apiRequests} (rapidapi)`,
    `searches ok=${okSearches}/${pairs.length}` + (Object.keys(fails).length ? ` fails=${JSON.stringify(fails)}` : ""),
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
  if (pairs.length && okSearches === 0) {
    console.error(`::error::every search failed (${JSON.stringify(fails)}) — no jobs were fetched`);
    process.exitCode = 1;
  } else if (okSearches < pairs.length) {
    console.warn(`::warning::${pairs.length - okSearches}/${pairs.length} searches failed — this run saw only part of the feed`);
  }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
