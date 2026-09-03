// GTM Jobs Feed — GitHub-native runtime.
// Finds GTM Engineer / Go-To-Market Engineer / GTM Operations / Growth Engineer / Growth Lead roles
// (US, EU, AU) at companies of ANY size, opens ONE GitHub issue per new job post with its points
// of contact, and pushes those points of contact to an Aimfox campaign.
// Runs weekly on GitHub Actions (see .github/workflows/daily.yml). Node 20+, zero dependencies.
//
// Job search: Blitz POST /v2/jobs/search (free/unlimited on the GEX plan).
// Contacts: GetLeads colleagues-by-domain first, Prospeo /search-person if that misses.
// Blitz company enrich is only used for size + domain so the contact cascade has something
// to query — it does not find people.
//
// Env: BLITZ_API_KEY (required); GETLEADS_API_KEY, PROSPEO_API_KEY (contacts — at least one);
// AIMFOX_API_KEY, AIMFOX_CAMPAIGN_ID (optional); GITHUB_TOKEN + GITHUB_REPOSITORY (Actions).
// Optional: RECENT_DAYS (default 7), MAX_ISSUES (default 40), MAX_PAGES (default 20), DRY_RUN=1.

import { readFile, writeFile } from "node:fs/promises";

const BLITZ = "https://api.blitz-api.ai";
const BLITZ_JOBS_SEARCH = `${BLITZ}/v2/jobs/search`;
const BLITZ_ENRICH = `${BLITZ}/v2/enrichment/company`;
const BLITZ_LI_TO_DOMAIN = `${BLITZ}/v2/enrichment/linkedin-to-domain`;
const GETLEADS_COLLEAGUES = "https://app.getleads.io/api/v1/contacts/lookup/colleagues";
const PROSPEO_PERSON = "https://api.prospeo.io/search-person";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const HIRING_TITLES = [
  "GTM Engineer", "Go To Market Engineer", "Go-to-Market Engineer", "Go-To-Market Engineer",
  "GTM Operations", "Growth Engineer", "Growth Lead",
];

const ROLE_FAMILIES = [
  { label: "GTM Engineer", re: /(gtm|go[-\s]*to[-\s]*market)[-\s]*(systems?[-\s]*|solutions?[-\s]*)?engineer/i },
  { label: "GTM Operations", re: /(gtm|go[-\s]*to[-\s]*market)[-\s]*(ops\b|operations)/i },
  { label: "Growth Engineer", re: /(growth[-\s]*(systems?[-\s]*|software[-\s]*|product[-\s]*)?engineer|\bengineer[,\s-]+growth\b)/i },
  { label: "Growth Lead", re: /(growth[-\s]*(team[-\s]*)?lead\b|\blead[,\s-]+growth\b)/i },
];
const titleFamily = (t) => ROLE_FAMILIES.find((f) => f.re.test(t ?? ""))?.label ?? "";

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "GB", "UK", "CH", "NO", "IS", "LI",
]);

const DM_EXCLUDE = ["assistant", "intern", "executive business partner", "account executive",
  "sales development representative", "business development representative", "customer success",
  "recruiter", "talent", "coordinator", "student", "support"];
const T_CEO = ["CEO", "Chief Executive Officer", "Founder", "Co-Founder", "Owner", "President", "Managing Director"];
const T_REV = ["CRO", "Chief Revenue Officer", "VP Sales", "VP of Sales", "Head of Sales", "Head of Revenue",
  "Chief Commercial Officer", "COO", "Director Sales", "Director of Sales", "Director Business Development",
  "Director of Business Development", "Head of Business Development", "BDR Manager", "SDR Manager"];
const T_GROWTH = ["Head of Growth", "VP Growth", "Chief Growth Officer", "Head of GTM", "GTM Lead",
  "Go-to-Market", "CMO", "Chief Marketing Officer", "VP Marketing", "Head of Marketing", "Head of Demand Generation"];
const T_ENTERPRISE = ["Head of Growth", "VP Growth", "Director of Growth", "Head of GTM", "GTM Lead",
  "Director of Revenue Operations", "Head of Revenue Operations", "VP Revenue Operations",
  "Director of Sales Operations", "Head of Sales Operations", "Director of Demand Generation"];
const SIZE_BANDS = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"];
const SMALL_SIZES = new Set(["1-10", "11-50", "51-200"]);
const MID_SIZES = new Set(["201-500", "501-1000"]);
const ENTERPRISE_SIZES = new Set(["1001-5000", "5001-10000", "10001+"]);

const RECENT_DAYS = Number(process.env.RECENT_DAYS || 7);
const MAX_ISSUES = Number(process.env.MAX_ISSUES || 40);
const MAX_PAGES = Number(process.env.MAX_PAGES || 20);
const MAX_DMS = 3;
const DRY_RUN = process.env.DRY_RUN === "1";
const TIMEOUT_MS = 25000, DM_CONCURRENCY = 3;
const SEARCH_SPACING_MS = 500;

const SEEN_PATH = new URL("../state/seen.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tfetch = (url, init = {}, ms = TIMEOUT_MS) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

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
function bareDomain(u) {
  if (!u) return "";
  try {
    const host = new URL(u.includes("://") ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase();
    return host;
  } catch { return String(u).replace(/^www\./, "").toLowerCase(); }
}
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
function dmTitlesFor(tier) {
  if (tier === "enterprise") return T_ENTERPRISE;
  if (tier === "mid") return [...T_GROWTH, ...T_REV];
  return [...T_CEO, ...T_REV, ...T_GROWTH];
}
function titleWanted(title, include) {
  const t = String(title || "").toLowerCase();
  if (!t) return false;
  if (DM_EXCLUDE.some((x) => t.includes(x))) return false;
  return include.some((x) => t.includes(x.toLowerCase()));
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
function sizeTier(band) {
  if (ENTERPRISE_SIZES.has(band)) return "enterprise";
  if (MID_SIZES.has(band)) return "mid";
  return "small";
}

async function companyEnrich(blitzKey, companyUrl) {
  const out = { size: "", domain: "" };
  if (!blitzKey || !companyUrl) return out;
  try {
    await pace();
    const r = await tfetch(BLITZ_ENRICH, { method: "POST", headers: blitzHeaders(blitzKey), body: JSON.stringify({ company_linkedin_url: companyUrl }) }, 30000);
    const d = await r.json();
    const c = d?.found ? (d.company ?? d) : (d.company ?? {});
    if (c.size && SIZE_BANDS.includes(c.size)) out.size = c.size;
    else out.size = bandFromHeadcount(c.employees_on_linkedin);
    out.domain = bareDomain(c.domain || c.website || c.company_domain || "");
  } catch { /* continue */ }
  if (!out.domain) {
    try {
      await pace();
      const r = await tfetch(BLITZ_LI_TO_DOMAIN, { method: "POST", headers: blitzHeaders(blitzKey), body: JSON.stringify({ company_linkedin_url: companyUrl }) }, 30000);
      const d = await r.json();
      out.domain = bareDomain(d.domain || d.company_domain || "");
    } catch { /* leave empty */ }
  }
  return out;
}

function normalizePerson(p) {
  const url = p.profile_url || p.linkedin_url || p.person_linkedin_url || "";
  const name = p.name || p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim();
  const title = p.title || p.job_title || p.current_job_title || p.headline || "";
  if (!url || !name) return null;
  return { profile_url: url, name, title };
}

async function getleadsContacts(key, domain, include) {
  if (!key || !domain) return [];
  await pace();
  const r = await tfetch(GETLEADS_COLLEAGUES, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": BROWSER_UA },
    body: JSON.stringify({ email_domain: domain, limit_per_item: 50 }),
  }, 40000);
  if (r.status === 402) {
    console.warn(`::warning::GetLeads fair-use limit on ${domain} — falling through to Prospeo`);
    return [];
  }
  if (!r.ok) return [];
  const d = await r.json().catch(() => ({}));
  const rows = d.contacts || d.results || d.data || (Array.isArray(d) ? d : []);
  const out = [];
  for (const c of rows) {
    if (!titleWanted(c.job_title || c.title, include)) continue;
    const p = normalizePerson(c);
    if (p) out.push(p);
  }
  return out;
}

async function prospeoContacts(key, domain, include) {
  if (!key || !domain) return [];
  await pace();
  const r = await tfetch(PROSPEO_PERSON, {
    method: "POST",
    headers: { "X-KEY": key, "Content-Type": "application/json", "User-Agent": BROWSER_UA },
    body: JSON.stringify({
      page: 1,
      filters: {
        company: { websites: { include: [domain] } },
        person_job_title: { include, exclude: DM_EXCLUDE },
      },
    }),
  }, 40000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return [];
  const out = [];
  for (const row of (j.results ?? [])) {
    const p = row.person ?? row;
    if (!titleWanted(p.job_title || p.title || p.current_job_title, include)) continue;
    const n = normalizePerson(p);
    if (n) out.push(n);
  }
  return out;
}

async function findDecisionMakers(secrets, domain, tier) {
  const include = dmTitlesFor(tier);
  const seen = new Set();
  const out = [];
  const add = (people) => {
    for (const p of people) {
      const k = (p.profile_url || p.name).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
      if (out.length >= MAX_DMS) return true;
    }
    return false;
  };
  add(await getleadsContacts(secrets.GETLEADS_API_KEY, domain, include));
  if (out.length < MAX_DMS) add(await prospeoContacts(secrets.PROSPEO_API_KEY, domain, include));
  return out;
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
    const r = await tfetch(BLITZ_JOBS_SEARCH, { method: "POST", headers: blitzHeaders(key), body: JSON.stringify(body) });
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
  lines.push(`### Points of contact (${it.dms.length})`);
  if (it.dms.length) {
    for (const d of it.dms) lines.push(`- [${d.name}](${d.profile_url})${d.title ? ` — ${d.title}` : ""}`);
    lines.push("");
    lines.push(it.aimfoxQueued
      ? `_Queued to Aimfox campaign for LinkedIn connection requests._`
      : `_Aimfox push not configured — work these manually._`);
  } else {
    lines.push("_No points of contact found via GetLeads or Prospeo._");
  }
  lines.push("");
  lines.push(`<!-- gtm-jobs-feed job_id=${it.jobId} -->`);
  return lines.join("\n");
}

async function main() {
  const secrets = {
    BLITZ_API_KEY: process.env.BLITZ_API_KEY,
    GETLEADS_API_KEY: process.env.GETLEADS_API_KEY,
    PROSPEO_API_KEY: process.env.PROSPEO_API_KEY,
    AIMFOX_API_KEY: process.env.AIMFOX_API_KEY,
    AIMFOX_CAMPAIGN_ID: process.env.AIMFOX_CAMPAIGN_ID,
  };
  if (!secrets.BLITZ_API_KEY) throw new Error("BLITZ_API_KEY missing");
  if (!secrets.GETLEADS_API_KEY && !secrets.PROSPEO_API_KEY) throw new Error("GETLEADS_API_KEY or PROSPEO_API_KEY missing");
  const seen = await loadSeen();
  const today = new Date().toISOString().slice(0, 10);

  if (process.env.GITHUB_EVENT_NAME === "schedule" && seen.lastOkRun === today) {
    console.log(`skipped: a scheduled run already fetched successfully today (${today}) — 0 API requests made`);
    return;
  }

  const cutoff = Date.now() - RECENT_DAYS * 86400_000;
  const search = await searchBlitzJobs(secrets.BLITZ_API_KEY);

  let fetched = 0;
  const fresh = new Map();
  for (const j of search.jobs) {
    fetched++;
    const jid = jobIdFrom(j);
    if (!jid || fresh.has(jid)) continue;
    if (!titleFamily(j.title)) continue;
    if (postedTs(j.date_posted) && postedTs(j.date_posted) < cutoff) continue;
    const region = regionFromJob(j);
    if (!region) continue;
    j._region = region;
    j._id = jid;
    fresh.set(jid, j);
  }

  const items = [];
  for (const [jid, j] of fresh) {
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
      jobUrl: j.url || "", size: "", tier: "small", domain: "", dms: [], aimfoxQueued: false,
    });
  }
  for (const it of items) seen.companies.delete(it.companyKey);
  const matched = items.length;

  let capped = 0;
  if (items.length > MAX_ISSUES) { capped = items.length - MAX_ISSUES; items.length = MAX_ISSUES; }

  const useAimfox = !!(secrets.AIMFOX_API_KEY && secrets.AIMFOX_CAMPAIGN_ID);
  await mapPool(items, DM_CONCURRENCY, async (it) => {
    const extra = await companyEnrich(secrets.BLITZ_API_KEY, it.companyUrl);
    it.size = extra.size;
    it.tier = sizeTier(it.size);
    it.domain = extra.domain;
    it.dms = await findDecisionMakers(secrets, it.domain, it.tier);
    it.aimfoxQueued = useAimfox && it.dms.length > 0;
  });

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

  let dmDiag = "aimfox: skipped";
  if (useAimfox && dmProfiles.length && !DRY_RUN) {
    const res = await pushToAimfox(secrets.AIMFOX_API_KEY, secrets.AIMFOX_CAMPAIGN_ID, dmProfiles);
    dmDiag = `aimfox: ${dmProfiles.length} sent, ${res.note}`;
  } else if (useAimfox && DRY_RUN) {
    dmDiag = `aimfox: would push ${dmProfiles.length}`;
  } else if (!useAimfox) {
    dmDiag = `aimfox: not configured (${dmProfiles.length} DMs in issues only)`;
  }

  if (search.status === "ok" || search.status === "empty") seen.lastOkRun = today;
  await saveSeen(seen);

  const summary = [
    `fetched=${fetched} matched=${matched} new=${items.length} issues=${issuesCreated}` + (capped ? ` capped=${capped}` : ""),
    `requests=${search.pages} (blitz /v2/jobs/search)`,
    `searches ${search.status}` + (search.lastError ? ` error=${search.lastError}` : ""),
    `contacts: getleads then prospeo`,
    dmDiag,
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
