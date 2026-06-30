// One-off backfill: file a GitHub issue for every GTM job already in the legacy Google Sheet
// (since the workflow started 2026-06-11), with points of contact looked up via Blitz.
// Does NOT push to Aimfox (those companies were already pushed by the original pipeline).
// Idempotent: skips any job_id already present in an existing issue, so it's safe to re-run.
//
//   SHEETS_SA_PATH=... BLITZ_API_KEY=... GITHUB_TOKEN=$(gh auth token) \
//   GITHUB_REPOSITORY=mariellecamba-gtm/gtm-jobs-feed node scripts/backfill.mjs
import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";

const SHEET_ID = process.env.SHEET_ID || "1WCAsLchLkmTKuK1z9A8037k_cbAW0y8gouCCcQBZsG4";
const TAB = process.env.SHEET_TAB || "Sheet1";
const SA_PATH = process.env.SHEETS_SA_PATH;
const BLITZ = process.env.BLITZ_API_KEY;
const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || "mariellecamba-gtm/gtm-jobs-feed";
const [OWNER, NAME] = REPO.split("/");
if (!SA_PATH || !BLITZ || !TOKEN) { console.error("need SHEETS_SA_PATH, BLITZ_API_KEY, GITHUB_TOKEN"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tfetch = (url, init = {}, ms = 40000) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const canonCompanyUrl = (u) => { const m = String(u || "").match(/(https?:\/\/[^/]*linkedin\.com\/company\/[^/?#]+)/i); return m ? m[1] : ""; };
const jobIdOf = (u) => (String(u || "").match(/jobs\/view\/(\d+)/) || [])[1] || "";

async function mapPool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---- Blitz POC discovery (same tiers as scripts/run.mjs) ----
const DM_EXCLUDE = ["assistant", "intern", "executive business partner", "account executive",
  "sales development representative", "business development representative", "customer success", "recruiter", "talent", "coordinator", "student", "support"];
const tier = (t) => ({ include_title: t, exclude_title: DM_EXCLUDE, location: ["WORLD"], include_headline_search: false });
const T_CEO = tier(["CEO", "Chief Executive Officer", "Founder", "Co-Founder", "Owner", "President", "Managing Director"]);
const T_REV = tier(["CRO", "Chief Revenue Officer", "VP Sales", "VP of Sales", "Head of Sales", "Head of Revenue", "Chief Commercial Officer", "COO",
  "Director Sales", "Director of Sales", "Director Business Development", "Director of Business Development", "Head of Business Development", "BDR Manager", "SDR Manager"]);
const T_GROWTH = tier(["Head of Growth", "VP Growth", "Chief Growth Officer", "Head of GTM", "GTM Lead", "Go-to-Market", "CMO", "Chief Marketing Officer", "VP Marketing", "Head of Marketing", "Head of Demand Generation"]);
const LARGE = new Set(["201-500", "501-1000", "1001-5000", "5001-10000", "10001+"]);
const SMALL = new Set(["1-10", "11-50", "51-200"]);

async function isLarge(cu) {
  try {
    const r = await tfetch("https://api.blitz-api.ai/v2/enrichment/company", { method: "POST", headers: { "x-api-key": BLITZ, "Content-Type": "application/json" }, body: JSON.stringify({ company_linkedin_url: cu }) }, 30000);
    const d = await r.json(); const c = d?.found ? (d.company ?? {}) : {};
    if (c.size && LARGE.has(c.size)) return true;
    if (c.size && SMALL.has(c.size)) return false;
    if (typeof c.employees_on_linkedin === "number") return c.employees_on_linkedin > 200;
  } catch {} return false;
}
async function findPOCs(cu, large) {
  const cascade = large ? [T_GROWTH, T_REV] : [T_CEO, T_REV, T_GROWTH];
  try {
    const r = await tfetch("https://api.blitz-api.ai/v2/search/waterfall-icp-keyword", { method: "POST", headers: { "x-api-key": BLITZ, "Content-Type": "application/json" }, body: JSON.stringify({ company_linkedin_url: cu, cascade, max_results: 3 }) }, 40000);
    const d = await r.json(); const out = [], seen = new Set();
    for (const it of (d?.results ?? [])) { const p = it.person ?? it; const url = p.linkedin_url, nm = (p.full_name ?? "").toLowerCase(); if (url && !seen.has(nm)) { seen.add(nm); out.push({ url, name: p.full_name, title: p.job_title || p.title || p.headline || "" }); } }
    return out;
  } catch { return []; }
}

// ---- Google Sheets read ----
async function sheetRows() {
  const sa = JSON.parse(await readFile(SA_PATH, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }))}`;
  const jwt = `${input}.${b64url(createSign("RSA-SHA256").update(input).sign(sa.private_key))}`;
  const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const tok = (await tr.json()).access_token;
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A2:H10000`, { headers: { Authorization: `Bearer ${tok}` } });
  return (await r.json()).values || [];
}

// ---- existing issues (idempotency) ----
async function existingJobIds() {
  const ids = new Set();
  for (let page = 1; page <= 20; page++) {
    const r = await tfetch(`https://api.github.com/repos/${OWNER}/${NAME}/issues?state=all&per_page=100&page=${page}`, { headers: gh() });
    const arr = await r.json(); if (!Array.isArray(arr) || !arr.length) break;
    for (const it of arr) { const m = String(it.body || "").match(/job_id=(\d+)/); if (m) ids.add(m[1]); }
    if (arr.length < 100) break;
  }
  return ids;
}
const gh = () => ({ Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gtm-jobs-feed-backfill", "Content-Type": "application/json" });

async function createIssue(title, body, labels) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await tfetch(`https://api.github.com/repos/${OWNER}/${NAME}/issues`, { method: "POST", headers: gh(), body: JSON.stringify({ title, body, labels }) }, 30000);
    if (r.ok) return (await r.json()).number;
    if (r.status === 403 || r.status === 429) { await sleep(20000); continue; } // secondary rate limit
    throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
  }
  throw new Error("rate-limited after retries");
}

function body(it) {
  const L = [];
  L.push(`**Company:** ${it.cu ? `[${it.company}](${it.cu})` : it.company}`);
  L.push(`**Role:** ${it.title}`);
  L.push(`**Location:** ${it.location} · ${it.region}`);
  if (it.posted) L.push(`**Posted:** ${it.posted}`);
  if (it.jobUrl) L.push(`**Job post:** ${it.jobUrl}`);
  L.push(`**Company size:** ${it.large ? "201+ employees" : "≤200 employees"}`);
  L.push("");
  L.push(`### Points of contact (${it.pocs.length})`);
  if (it.pocs.length) { for (const p of it.pocs) L.push(`- [${p.name}](${p.url})${p.title ? ` — ${p.title}` : ""}`); L.push(""); L.push("_Backfilled from the launch sheet — already in the Aimfox campaign from the original run._"); }
  else L.push("_No points of contact found by the waterfall search._");
  L.push(""); L.push(`<!-- gtm-jobs-feed job_id=${it.jobId} backfill=1 -->`);
  return L.join("\n");
}

// ---- main ----
const rows = await sheetRows();
const seenIds = await existingJobIds();
console.log(`sheet rows: ${rows.length}, already-filed job_ids: ${seenIds.size}`);

// dedupe by company (keep last/most-recent occurrence), skip already-filed job_ids
const byCompany = new Map();
for (const row of rows) {
  const [, title, company, location, region, posted, companyUrl, jobUrl] = row;
  const cu = canonCompanyUrl(companyUrl); const jobId = jobIdOf(jobUrl);
  const ckey = (cu || company || "").toLowerCase().trim();
  if (!ckey) continue;
  byCompany.set(ckey, { company: company || "(unknown)", cu, region: region || "", title: title || "GTM Engineer", location: location || "", posted: posted || "", jobUrl: jobUrl || "", jobId });
}
const items = [...byCompany.values()].filter((it) => !it.jobId || !seenIds.has(it.jobId));
console.log(`unique companies: ${byCompany.size}, to backfill (new): ${items.length}`);

// POC lookup (concurrency 3)
let done = 0;
await mapPool(items, 3, async (it) => {
  if (it.cu) { it.large = await isLarge(it.cu); it.pocs = await findPOCs(it.cu, it.large); }
  else { it.large = false; it.pocs = []; }
  if (++done % 20 === 0) console.log(`  POCs looked up: ${done}/${items.length}`);
});

// create issues (sequential + gentle pacing)
let created = 0, withPocs = 0; const errs = [];
for (const it of items) {
  try {
    const n = await createIssue(`${it.company} — ${it.title} · ${it.region}`, body(it), ["gtm-job", `region:${it.region}`, it.large ? "size:201+" : "size:1-200", "backfill"]);
    created++; if (it.pocs.length) withPocs++;
    if (created % 25 === 0) console.log(`  issues created: ${created}`);
    await sleep(350);
  } catch (e) { errs.push(`${it.company}: ${e.message || e}`); }
}
console.log(`\nDONE — created ${created} issues (${withPocs} with POCs, ${created - withPocs} empty). errors: ${errs.length}`);
if (errs.length) console.log(errs.slice(0, 10).join("\n"));
