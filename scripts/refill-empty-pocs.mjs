// One-off: re-search points of contact for GitHub issues that have none, patch the
// issue body, and push new people to Aimfox. Uses the same GetLeads → Prospeo
// cascade as run.mjs, then Blitz waterfall as a last pass.
//
//   node scripts/refill-empty-pocs.mjs
//   DRY_RUN=1 node scripts/refill-empty-pocs.mjs
const BLITZ = "https://api.blitz-api.ai";
const GETLEADS_COLLEAGUES = "https://app.getleads.io/api/v1/contacts/lookup/colleagues";
const PROSPEO_PERSON = "https://api.prospeo.io/search-person";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REPO = process.env.GITHUB_REPOSITORY || "mariellecamba-gtm/gtm-jobs-feed";
const [OWNER, NAME] = REPO.split("/");
const CAMPAIGN_ID = process.env.AIMFOX_CAMPAIGN_ID || "4cfd224c-9f47-4085-8104-7ef8798a239a";
const DRY_RUN = process.env.DRY_RUN === "1";
// LIMIT=3 for a canary: only the newest N empty issues.
const LIMIT = Number(process.env.LIMIT || 0);
const TODAY = new Date().toISOString().slice(0, 10);
const MAX_DMS = 3;
const TIMEOUT_MS = 25000;
const DM_CONCURRENCY = 3;
const SEARCH_SPACING_MS = 500;

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
function bareDomain(u) {
  if (!u) return "";
  try {
    return new URL(u.includes("://") ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch { return String(u).replace(/^www\./, "").toLowerCase(); }
}
function canonCompanyUrl(u) {
  const m = String(u || "").match(/(https?:\/\/[^/]*linkedin\.com\/company\/[^/?#]+)/i);
  return m ? m[1] : "";
}
function blitzHeaders(key) {
  return { "x-api-key": key, "Content-Type": "application/json", "User-Agent": BROWSER_UA };
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
// 201+ employees: the exact titles above missed most people ("Director, Growth
// Marketing & Analytics" is not "Director of Growth"), so also accept any
// director-or-above title in a GTM area.
const BROAD_AREAS = ["growth", "revenue operations", "revops", "rev ops", "gtm", "go-to-market",
  "go to market", "sales operations", "sales ops", "marketing operations", "demand gen", "revenue"];
const SENIOR_RE = /\b(director|head|vp|vice president|svp|evp|chief)\b/;
function dmTitlesFor(tier) {
  const list = tier === "enterprise" ? [...T_ENTERPRISE]
    : tier === "mid" ? [...T_GROWTH, ...T_REV]
    : [...T_CEO, ...T_REV, ...T_GROWTH];
  list.broad = tier !== "small";
  return list;
}
function titleWanted(title, include) {
  const t = String(title || "").toLowerCase();
  if (!t) return false;
  if (DM_EXCLUDE.some((x) => t.includes(x))) return false;
  if (include.some((x) => t.includes(x.toLowerCase()))) return true;
  return !!include.broad && SENIOR_RE.test(t) && BROAD_AREAS.some((a) => t.includes(a));
}
function normalizePerson(p) {
  const url = p.profile_url || p.linkedin_url || p.person_linkedin_url || "";
  const name = p.name || p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim();
  const title = p.title || p.job_title || p.current_job_title || p.headline || "";
  if (!url || !name) return null;
  return { profile_url: url, name, title };
}

async function companyEnrich(blitzKey, companyUrl) {
  const out = { size: "", domain: "" };
  if (!blitzKey || !companyUrl) return out;
  try {
    await pace();
    const r = await tfetch(`${BLITZ}/v2/enrichment/company`, { method: "POST", headers: blitzHeaders(blitzKey), body: JSON.stringify({ company_linkedin_url: companyUrl }) }, 30000);
    const d = await r.json();
    const c = d?.found ? (d.company ?? d) : (d.company ?? {});
    if (c.size && SIZE_BANDS.includes(c.size)) out.size = c.size;
    else out.size = bandFromHeadcount(c.employees_on_linkedin);
    out.domain = bareDomain(c.domain || c.website || c.company_domain || "");
  } catch { /* continue */ }
  if (!out.domain) {
    try {
      await pace();
      const r = await tfetch(`${BLITZ}/v2/enrichment/linkedin-to-domain`, { method: "POST", headers: blitzHeaders(blitzKey), body: JSON.stringify({ company_linkedin_url: companyUrl }) }, 30000);
      const d = await r.json();
      out.domain = bareDomain(d.domain || d.company_domain || "");
    } catch { /* leave empty */ }
  }
  return out;
}

async function getleadsContacts(key, domain, include) {
  if (!key || !domain) return [];
  await pace();
  const r = await tfetch(GETLEADS_COLLEAGUES, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": BROWSER_UA },
    body: JSON.stringify({ email_domain: domain, limit_per_item: 50 }),
  }, 40000);
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

// Fallback when Blitz gives no domain (e.g. its monthly fair-use limit, HTTP 402):
// look the company up in Prospeo by name and accept the domain only when the
// result's LinkedIn company page is the one on the job post, so a common name
// ("Future", "Nomad") never resolves to someone else.
const liSlug = (u) => (String(u || "").match(/linkedin\.com\/company\/([^/?#]+)/i)?.[1] || "").toLowerCase();
async function prospeoCompany(key, name, companyUrl) {
  const out = { size: "", domain: "" };
  const want = liSlug(companyUrl);
  if (!key || !name || !want) return out;
  for (let page = 1; page <= 3; page++) {
    await pace();
    const r = await tfetch(PROSPEO_PERSON, {
      method: "POST",
      headers: { "X-KEY": key, "Content-Type": "application/json", "User-Agent": BROWSER_UA },
      body: JSON.stringify({ page, filters: { company: { names: { include: [name] } } } }),
    }, 40000).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok || j.error) break;
    const hit = (j.results ?? []).map((x) => x.company || {}).find((c) => liSlug(c.linkedin_url) === want);
    if (hit) {
      out.domain = bareDomain(hit.domain || hit.website || "");
      if (SIZE_BANDS.includes(hit.employee_range)) out.size = hit.employee_range;
      else out.size = bandFromHeadcount(Number(hit.employee_count));
      return out;
    }
    if (page >= (j.pagination?.total_page ?? 1)) break;
  }
  return out;
}

async function prospeoContacts(key, domain, include) {
  if (!key || !domain) return [];
  // Seniority filter + local title pick: Prospeo's person_job_title only matches
  // its canonical titles and returned NO_RESULTS for our list (same fix as run.mjs).
  const out = [];
  for (let page = 1; page <= 3 && out.length < MAX_DMS; page++) {
    await pace();
    const r = await tfetch(PROSPEO_PERSON, {
      method: "POST",
      headers: { "X-KEY": key, "Content-Type": "application/json", "User-Agent": BROWSER_UA },
      body: JSON.stringify({
        page,
        filters: {
          company: { websites: { include: [domain] } },
          person_seniority: { include: ["C-Suite", "Founder/Owner", "Vice President", "Head", "Director"] },
        },
      }),
    }, 40000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      if (j.error_code !== "NO_RESULTS") console.warn(`Prospeo ${r.status} ${j.error_code || ""} on ${domain}`);
      break;
    }
    for (const row of (j.results ?? [])) {
      const p = row.person ?? row;
      if (!titleWanted(p.job_title || p.title || p.current_job_title, include)) continue;
      const n = normalizePerson(p);
      if (n) out.push(n);
    }
    if (page >= (j.pagination?.total_page ?? 1)) break;
  }
  return out;
}

async function blitzWaterfall(key, companyUrl, include) {
  if (!key || !companyUrl) return [];
  await pace();
  const cascade = [{ include_title: include, exclude_title: DM_EXCLUDE, location: ["WORLD"], include_headline_search: false }];
  try {
    const r = await tfetch(`${BLITZ}/v2/search/waterfall-icp-keyword`, {
      method: "POST",
      headers: blitzHeaders(key),
      body: JSON.stringify({ company_linkedin_url: companyUrl, cascade, max_results: MAX_DMS }),
    }, 40000);
    const d = await r.json();
    const out = [];
    for (const it of (d?.results ?? [])) {
      const p = normalizePerson(it.person ?? it);
      if (p) out.push(p);
    }
    return out;
  } catch { return []; }
}

async function findPeople(secrets, domain, companyUrl, tier) {
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
  if (!add(await getleadsContacts(secrets.GETLEADS_API_KEY, domain, include))) {
    if (!add(await prospeoContacts(secrets.PROSPEO_API_KEY, domain, include))) {
      add(await blitzWaterfall(secrets.BLITZ_API_KEY, companyUrl, include));
    }
  }
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

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "gtm-jobs-feed-refill",
  };
}

async function listIssues(token) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await tfetch(`https://api.github.com/repos/${OWNER}/${NAME}/issues?state=all&per_page=100&page=${page}`, { headers: ghHeaders(token) });
    if (!r.ok) throw new Error(`list issues ${r.status}`);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) break;
    for (const it of arr) {
      if (it.pull_request) continue;
      out.push(it);
    }
    if (arr.length < 100) break;
  }
  return out;
}

function parseEmpty(it) {
  const body = it.body || "";
  if (/linkedin\.com\/in\//i.test(body) && !/_No points of contact found/i.test(body)) return null;
  const cu = canonCompanyUrl((body.match(/\*\*Company:\*\*\s*\[[^\]]+\]\((https?:\/\/[^)]+)\)/) || [])[1] || "");
  const company = ((body.match(/\*\*Company:\*\*\s*\[([^\]]+)\]/) || [])[1]
    || String(it.title || "").split(/\s*[—–]\s*/)[0] || "").trim();
  const jobId = (body.match(/job_id=(\d+)/) || [])[1] || "";
  return { number: it.number, title: it.title, body, company, companyUrl: cu, jobId };
}

function patchBody(oldBody, people, aimfoxQueued) {
  const pocLines = [`### Points of contact (${people.length})`];
  if (people.length) {
    for (const p of people) pocLines.push(`- [${p.name}](${p.profile_url})${p.title ? ` — ${p.title}` : ""}`);
    pocLines.push("");
    pocLines.push(aimfoxQueued
      ? `_Queued to Aimfox campaign for LinkedIn connection requests._`
      : `_Aimfox push not configured — work these manually._`);
  } else {
    pocLines.push(`_No points of contact found via GetLeads, Prospeo, or Blitz (refill ${TODAY})._`);
  }
  const next = pocLines.join("\n");
  if (/### Points of contact[\s\S]*?(?=\n<!-- |\n*$)/.test(oldBody)) {
    return oldBody.replace(/### Points of contact[\s\S]*?(?=\n<!-- |\n*$)/, next + "\n");
  }
  return oldBody.trimEnd() + "\n\n" + next + "\n";
}

async function updateIssue(token, number, body) {
  const r = await tfetch(`https://api.github.com/repos/${OWNER}/${NAME}/issues/${number}`, {
    method: "PATCH",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  }, 30000);
  if (!r.ok) throw new Error(`patch #${number} ${r.status} ${(await r.text()).slice(0, 160)}`);
}

async function main() {
  const secrets = {
    BLITZ_API_KEY: process.env.BLITZ_API_KEY,
    GETLEADS_API_KEY: process.env.GETLEADS_API_KEY,
    PROSPEO_API_KEY: process.env.PROSPEO_API_KEY,
    AIMFOX_API_KEY: process.env.AIMFOX_API_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  if (!secrets.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN missing");
  if (!secrets.BLITZ_API_KEY) throw new Error("BLITZ_API_KEY missing");
  if (!secrets.GETLEADS_API_KEY && !secrets.PROSPEO_API_KEY) throw new Error("GETLEADS_API_KEY or PROSPEO_API_KEY missing");

  const issues = await listIssues(secrets.GITHUB_TOKEN);
  const empty = issues.map(parseEmpty).filter(Boolean).sort((a, b) => b.number - a.number);
  if (LIMIT) empty.length = Math.min(empty.length, LIMIT);
  console.log(`issues=${issues.length} empty=${empty.length}`);

  const useAimfox = !!(secrets.AIMFOX_API_KEY && CAMPAIGN_ID);
  const toPush = [];
  let filled = 0, stillEmpty = 0, patched = 0, errors = 0;

  await mapPool(empty, DM_CONCURRENCY, async (it) => {
    try {
      const extra = await companyEnrich(secrets.BLITZ_API_KEY, it.companyUrl);
      if (!extra.domain) {
        const pc = await prospeoCompany(secrets.PROSPEO_API_KEY, it.company, it.companyUrl);
        extra.domain = pc.domain;
        extra.size ||= pc.size;
      }
      const tier = sizeTier(extra.size);
      it.people = await findPeople(secrets, extra.domain, it.companyUrl, tier);
      it.domain = extra.domain;
      it.size = extra.size;
      if (it.people.length) {
        filled++;
        for (const p of it.people) toPush.push({ profile_url: p.profile_url, company: it.company });
      } else {
        stillEmpty++;
      }
      const body = patchBody(it.body, it.people || [], useAimfox && it.people.length > 0);
      if (DRY_RUN) {
        console.log(`[dry-run] #${it.number} ${it.company} domain=${it.domain || "-"} people=${(it.people || []).length}`);
      } else {
        await updateIssue(secrets.GITHUB_TOKEN, it.number, body);
        patched++;
        console.log(`#${it.number} ${it.company} people=${(it.people || []).length}`);
      }
    } catch (e) {
      errors++;
      console.error(`#${it.number} ${it.company}: ${e.message || e}`);
    }
  });

  let aimfox = "aimfox: skipped";
  if (useAimfox && toPush.length && !DRY_RUN) {
    const res = await pushToAimfox(secrets.AIMFOX_API_KEY, CAMPAIGN_ID, toPush);
    aimfox = `aimfox: ${toPush.length} sent, ${res.note}`;
  } else if (useAimfox && DRY_RUN) {
    aimfox = `aimfox: would push ${toPush.length}`;
  } else if (!useAimfox) {
    aimfox = `aimfox: not configured (${toPush.length} people in issues only)`;
  }

  console.log(`filled=${filled} still_empty=${stillEmpty} patched=${patched} errors=${errors}`);
  console.log(aimfox);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
