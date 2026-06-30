// GTM Jobs Feed — GitHub-native runtime.
// Finds GTM Engineer / Go-To-Market Engineer roles (US, EU, AU, NZ), opens ONE GitHub issue
// per new job post with its points of contact, and pushes those points of contact to an Aimfox campaign.
// Runs on GitHub Actions (see .github/workflows/daily.yml). Node 20+, zero dependencies.
//
// Dedupe state lives in ../state/seen.json (committed back by the workflow) — one entry per job id
// AND one per company, so a company is never filed twice. This replaces the old Supabase table.
//
// Env: RAPIDAPI_KEY, BLITZ_API_KEY (required); AIMFOX_API_KEY, AIMFOX_CAMPAIGN_ID (optional — push
// is skipped if absent); GITHUB_TOKEN + GITHUB_REPOSITORY (auto-provided by Actions).
// Optional: RECENT_DAYS (default 21), MAX_ISSUES (safety cap, default 40), DRY_RUN=1 (no writes).

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

const RECENT_DAYS = Number(process.env.RECENT_DAYS || 21);
const MAX_ISSUES = Number(process.env.MAX_ISSUES || 40);
const DRY_RUN = process.env.DRY_RUN === "1";
const TIMEOUT_MS = 25000, RETRIES = 4, SEARCH_CONCURRENCY = 4, DM_CONCURRENCY = 3;

const SEEN_PATH = new URL("../state/seen.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tfetch = (url, init = {}, ms = TIMEOUT_MS) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

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
    return { jobIds: new Set(j.jobIds || []), companies: new Set((j.companies || []).map((c) => c.toLowerCase())) };
  } catch { return { jobIds: new Set(), companies: new Set() }; }
}
async function saveSeen(seen) {
  const body = JSON.stringify({
    updatedAt: process.env.RUN_TIMESTAMP || "",
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

async function searchJobs(key, kw, geo) {
  let last = "empty";
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const qs = new URLSearchParams({ keywords: kw, locationId: geo });
      const r = await tfetch(`${JOB_URL}?${qs}`, { headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": JOB_HOST } });
      if (r.status === 429) return { jobs: [], status: "http429" };
      if (!r.ok) { last = `http${r.status}`; await sleep(900 * (attempt + 1)); continue; }
      const j = await r.json();
      if (Array.isArray(j?.data) && j.data.length) return { jobs: j.data, status: "ok" };
      last = j?.success === false ? "transient" : "empty";
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

  // 6) persist dedupe state
  await saveSeen(seen);

  const summary = [
    `fetched=${fetched} matched=${matched} new=${items.length} issues=${issuesCreated}` + (capped ? ` capped=${capped}` : ""),
    `searches ok=${okSearches}/${pairs.length}` + (Object.keys(fails).length ? ` fails=${JSON.stringify(fails)}` : ""),
    dmDiag,
    issueErrors.length ? `issue errors: ${issueErrors.slice(0, 5).join(" | ")}` : "",
  ].filter(Boolean).join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY && !DRY_RUN) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `### GTM Jobs Feed\n\n\`\`\`\n${summary}\n\`\`\`\n`, { flag: "a" });
  }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
