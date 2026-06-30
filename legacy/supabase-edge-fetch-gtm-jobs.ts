// fetch-gtm-jobs — GTM Engineer / Go-To-Market Engineer roles across US, EU, AU, NZ (any size).
// Writes new roles straight into a Google Sheet via the clickupgex service account (Sheets API).
// Uses professional-network-data RapidAPI (Harochi key). Cron-triggered daily via pg_cron + net.http_post.
import { createClient } from "jsr:@supabase/supabase-js@2";

const JOB_HOST = "professional-network-data.p.rapidapi.com";
const JOB_URL = `https://${JOB_HOST}/search-jobs-v2`;

const KEYWORDS = ["GTM Engineer", "Go To Market Engineer"];
const LOCATIONS: Record<string, string> = {
  "US": "103644278",
  "EU": "91000000",
  "Australia": "101452733",
  "New Zealand": "105490917",
};
const TITLE_ALLOW = /(gtm\s*engineer|go[-\s]*to[-\s]*market\s*engineer)/i;
const HEADER = ["Date Added", "Job Title", "Company", "Job Location", "Region", "Posted At", "Company LinkedIn", "Job URL"];

// --- Decision-maker push (Blitz Waterfall ICP -> Aimfox campaign) ---
const BLITZ_ENRICH = "https://api.blitz-api.ai/v2/enrichment/company";
const BLITZ_WATERFALL = "https://api.blitz-api.ai/v2/search/waterfall-icp-keyword";
const DM_EXCLUDE = ["assistant", "intern", "executive business partner", "account executive", "sdr", "bdr",
  "sales development", "business development representative", "customer success", "recruiter", "talent", "coordinator", "student", "support"];
const dmTier = (titles: string[]) => ({ include_title: titles, exclude_title: DM_EXCLUDE, location: ["WORLD"], include_headline_search: false });
const T_CEO = dmTier(["CEO", "Chief Executive Officer", "Founder", "Co-Founder", "Owner", "President", "Managing Director"]);
const T_REV = dmTier(["CRO", "Chief Revenue Officer", "VP Sales", "VP of Sales", "Head of Sales", "Head of Revenue", "Chief Commercial Officer", "COO"]);
const T_GROWTH = dmTier(["Head of Growth", "VP Growth", "Chief Growth Officer", "Head of GTM", "GTM Lead", "Go-to-Market", "CMO", "Chief Marketing Officer", "VP Marketing", "Head of Marketing", "Head of Demand Generation"]);
const LARGE_SIZES = new Set(["201-500", "501-1000", "1001-5000", "5001-10000", "10001+"]);
const SMALL_SIZES = new Set(["1-10", "11-50", "51-200"]);
const DM_CONCURRENCY = 3;

const RECENT_DAYS = 21;
const TIMEOUT_MS = 25000;
const RETRIES = 4;
const SEARCH_CONCURRENCY = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tfetch(url: string, init: RequestInit = {}, ms = TIMEOUT_MS) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}
async function mapPool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
function canonCompanyUrl(u: string | undefined): string {
  if (!u) return "";
  const m = u.match(/(https?:\/\/[^/]*linkedin\.com\/company\/[^/?#]+)/i);
  return m ? m[1] : "";
}

// ---- Google service-account auth + Sheets append ----
function b64urlBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string { return b64urlBytes(new TextEncoder().encode(s)); }
function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function getGoogleToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlStr(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));
  const jwt = `${signingInput}.${b64urlBytes(sig)}`;
  const r = await tfetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("token " + JSON.stringify(j).slice(0, 150));
  return j.access_token;
}
async function sheetIsEmpty(token: string, sheetId: string, tab: string): Promise<boolean> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!A1:A1`;
  const r = await tfetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  return !(j.values && j.values.length);
}
async function sheetAppend(token: string, sheetId: string, tab: string, values: any[][]) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const r = await tfetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  if (!r.ok) throw new Error(`sheets ${r.status} ${(await r.text()).slice(0, 150)}`);
}

// ---- Decision-maker discovery + Aimfox push ----
async function companyIsLarge(blitzKey: string, companyUrl: string): Promise<boolean> {
  try {
    const r = await tfetch(BLITZ_ENRICH, { method: "POST", headers: { "x-api-key": blitzKey, "Content-Type": "application/json" }, body: JSON.stringify({ company_linkedin_url: companyUrl }) }, 30000);
    const d = await r.json();
    const c = d?.found ? (d.company ?? {}) : {};
    if (c.size && LARGE_SIZES.has(c.size)) return true;
    if (c.size && SMALL_SIZES.has(c.size)) return false;
    if (typeof c.employees_on_linkedin === "number") return c.employees_on_linkedin > 200;
  } catch (_e) { /* default small */ }
  return false;
}
async function findDecisionMakers(blitzKey: string, companyUrl: string, large: boolean): Promise<{ profile_url: string; name: string }[]> {
  const cascade = large ? [T_GROWTH, T_REV] : [T_CEO, T_REV, T_GROWTH];
  try {
    const r = await tfetch(BLITZ_WATERFALL, { method: "POST", headers: { "x-api-key": blitzKey, "Content-Type": "application/json" }, body: JSON.stringify({ company_linkedin_url: companyUrl, cascade, max_results: 3 }) }, 40000);
    const d = await r.json();
    const out: { profile_url: string; name: string }[] = [];
    const names = new Set<string>();
    for (const item of (d?.results ?? [])) {
      const p = item.person ?? item;
      const url = p.linkedin_url, nm = (p.full_name ?? "").toLowerCase();
      if (url && !names.has(nm)) { names.add(nm); out.push({ profile_url: url, name: p.full_name }); }
    }
    return out;
  } catch (_e) { return []; }
}
// Aimfox resolves each LinkedIn URL server-side (slow), so use small batches + a generous timeout + retry.
async function pushToAimfox(aimfoxKey: string, campaignId: string, profiles: { profile_url: string; company: string }[]): Promise<{ added: number; note: string }> {
  let added = 0, failed = 0;
  const reasons = new Set<string>();
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
      } catch (_e) { reasons.add("timeout"); await sleep(1500); }
    }
  }
  const note = `${added} added, ${failed} skipped` + (reasons.size ? ` (${[...reasons].slice(0, 4).join(",")})` : "");
  return { added, note };
}

async function searchJobs(key: string, kw: string, geo: string): Promise<{ jobs: any[]; status: string }> {
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
    } catch (_e) { last = "timeout"; }
    await sleep(900 * (attempt + 1));
  }
  return { jobs: [], status: last };
}

async function runPipeline(sb: any, secrets: Record<string, string>) {
  const errors: string[] = [];
  let fetched = 0, matched = 0, kept = 0, sent = 0, dmPushed = 0;
  let searchDiag = "", dmDiag = "";
  try {
    const cutoff = Date.now() - RECENT_DAYS * 86400_000;
    const pairs: { kw: string; region: string }[] = [];
    for (const kw of KEYWORDS) for (const region of Object.keys(LOCATIONS)) pairs.push({ kw, region });

    const results = await mapPool(pairs, SEARCH_CONCURRENCY, async (p) => {
      const res = await searchJobs(secrets.RAPIDAPI_KEY, p.kw, LOCATIONS[p.region]);
      for (const j of res.jobs) j._region = p.region;
      return res;
    });
    const okSearches = results.filter((r) => r.status === "ok").length;
    const failSummary: Record<string, number> = {};
    for (const r of results) if (r.status !== "ok") failSummary[r.status] = (failSummary[r.status] ?? 0) + 1;
    searchDiag = `searches ok=${okSearches}/${pairs.length}` +
      (Object.keys(failSummary).length ? ` fails=${JSON.stringify(failSummary)}` : "");

    const fresh = new Map<string, any>();
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
    matched = fresh.size;

    const ids = [...fresh.keys()];
    for (let i = 0; i < ids.length; i += 300) {
      const { data: seen } = await sb.from("gtmjobs_seen").select("job_id").in("job_id", ids.slice(i, i + 300));
      for (const row of seen ?? []) fresh.delete(row.job_id);
    }

    // Company-level dedup: never push a company that's already in the sheet.
    const seenCompanies = new Set<string>();
    const { data: cs } = await sb.from("gtmjobs_seen").select("company_url");
    for (const r of cs ?? []) { const k = (r.company_url ?? "").toLowerCase(); if (k) seenCompanies.add(k); }

    const today = new Date().toISOString().slice(0, 10);
    const rows: any[][] = [];
    const keptJobs: any[] = [];
    const newCompanies: { name: string; cu: string }[] = [];
    for (const j of fresh.values()) {
      const cu = canonCompanyUrl(j?.company?.url);
      const ckey = (cu || (j.company?.name ?? "")).toLowerCase().trim();
      if (!ckey || seenCompanies.has(ckey)) continue; // skip company already pushed (this run or a prior one)
      seenCompanies.add(ckey);
      const posted = j.postedTimestamp ? new Date(j.postedTimestamp).toISOString().slice(0, 10) : "";
      rows.push([today, j.title ?? "", j.company?.name ?? "", j.location ?? "", j._region ?? "", posted, cu, j.url ?? ""]);
      keptJobs.push({ jid: String(j.id), title: j.title, cu });
      if (cu) newCompanies.push({ name: j.company?.name ?? "", cu });
    }
    kept = rows.length;

    // Write straight into the Google Sheet via service account, then mark seen
    const saB64 = secrets.GOOGLE_SERVICE_ACCOUNT_B64;
    const sheetId = secrets.SHEET_ID, tab = secrets.SHEET_TAB || "Sheet1";
    if (!saB64 || !sheetId) {
      errors.push("missing GOOGLE_SERVICE_ACCOUNT_B64 / SHEET_ID");
    } else if (rows.length) {
      const sa = JSON.parse(atob(saB64));
      const token = await getGoogleToken(sa);
      if (await sheetIsEmpty(token, sheetId, tab)) await sheetAppend(token, sheetId, tab, [HEADER]);
      for (let i = 0; i < rows.length; i += 500) {
        const chunkRows = rows.slice(i, i + 500);
        const chunkJobs = keptJobs.slice(i, i + 500);
        try {
          await sheetAppend(token, sheetId, tab, chunkRows);
          sent += chunkRows.length;
          await sb.from("gtmjobs_seen").upsert(chunkJobs.map((j) => ({ job_id: j.jid, title: j.title, company_url: j.cu })));
        } catch (e) { errors.push(`${e}`); }
      }
    }

    // For each NEW company, find CEO/Founder/Growth/Revenue/GTM decision-makers and push to Aimfox.
    // Size-aware: companies <=200 employees include the CEO/Founder; 200+ focus on growth/GTM/revenue.
    const blitzKey = secrets.BLITZ_API_KEY, aimfoxKey = secrets.AIMFOX_API_KEY, campaignId = secrets.AIMFOX_CAMPAIGN_ID;
    if (blitzKey && aimfoxKey && campaignId && newCompanies.length) {
      const dmProfiles: { profile_url: string; company: string }[] = [];
      await mapPool(newCompanies, DM_CONCURRENCY, async (co) => {
        const large = await companyIsLarge(blitzKey, co.cu);
        const dms = await findDecisionMakers(blitzKey, co.cu, large);
        for (const d of dms) dmProfiles.push({ profile_url: d.profile_url, company: co.name });
      });
      if (dmProfiles.length) {
        const res = await pushToAimfox(aimfoxKey, campaignId, dmProfiles);
        dmPushed = res.added;
        dmDiag = `dm: ${dmProfiles.length} found, ${res.note}`;
      } else {
        dmDiag = `dm: 0 found`;
      }
    }
  } catch (e) {
    errors.push(`fatal: ${e}`);
  } finally {
    const note = [searchDiag, dmDiag, ...errors.slice(0, 20)].filter(Boolean).join(" | ");
    await sb.from("gtmjobs_runs").insert({ fetched, matched, enriched: 0, kept, sent, errors: note || null });
    console.log(JSON.stringify({ fetched, matched, kept, sent, dmPushed, diag: searchDiag, dmDiag, errors: errors.length }));
  }
}

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, serviceKey);
  const { data: secrets, error } = await sb.rpc("get_gtmjobs_secrets");
  if (error || !secrets) return new Response(JSON.stringify({ error: "secrets unavailable" }), { status: 500 });
  if (req.headers.get("x-trigger-secret") !== secrets.TRIGGER_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  EdgeRuntime.waitUntil(runPipeline(sb, secrets).catch((e) => console.error("pipeline", e)));
  return new Response(JSON.stringify({ status: "started" }), { status: 202, headers: { "Content-Type": "application/json" } });
});
