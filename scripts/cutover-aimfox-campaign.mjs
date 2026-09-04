// Create a new Aimfox campaign, upload every GitHub-issue POC, print the new id.
// Completed leads cannot restart on the old campaign. New campaign + new audience does.
//
//   AIMFOX_API_KEY=... GITHUB_TOKEN=... node scripts/cutover-aimfox-campaign.mjs
import { writeFile } from "node:fs/promises";

const OLD_ID = process.env.AIMFOX_CAMPAIGN_ID || "333d3b30-393a-4a23-ab0f-001f41aedc6d";
const KEY = process.env.AIMFOX_API_KEY;
const REPO = process.env.GITHUB_REPOSITORY || "mariellecamba-gtm/gtm-jobs-feed";
const [OWNER, NAME] = REPO.split("/");
const TOKEN = process.env.GITHUB_TOKEN;
const NAME_NEW = process.env.AIMFOX_NEW_NAME || "GTM Engineer Hiring — Intro 2026-09-05";
const TIMEOUT_MS = 40000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tfetch = (url, init = {}, ms = TIMEOUT_MS) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

if (!KEY) throw new Error("AIMFOX_API_KEY missing");
if (!TOKEN) throw new Error("GITHUB_TOKEN missing");

function aimfox(path, init = {}) {
  return tfetch(`https://api.aimfox.com/api/v2${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function publicIdFromUrl(url) {
  const m = String(url || "").match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/\/$/, "") : "";
}

async function listIssues() {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await tfetch(`https://api.github.com/repos/${OWNER}/${NAME}/issues?state=all&per_page=100&page=${page}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gtm-jobs-feed-cutover",
      },
    });
    if (!r.ok) throw new Error(`github issues ${r.status}`);
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

function contactsFromIssues(issues) {
  const seen = new Set();
  const out = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)]*linkedin\.com\/in\/[^)]+)\)/g;
  for (const it of issues) {
    const company = String(it.title || "").split(/\s*[—–]\s*/)[0].trim();
    const body = it.body || "";
    let m;
    const local = new RegExp(re.source, "g");
    while ((m = local.exec(body))) {
      const profile_url = m[2].replace(/\/$/, "");
      const k = profile_url.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ profile_url, name: m[1].trim(), company });
    }
  }
  return out;
}

async function getOldCampaign() {
  const r = await aimfox(`/campaigns/${OLD_ID}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`get old campaign ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.campaign || j;
}

async function createCampaign(old) {
  const accountIds = [...new Set([...(old.owners || []), old.miner].filter(Boolean).map(String))];
  const body = {
    name: NAME_NEW,
    type: "list",
    outreach_type: old.outreach_type || "connect",
    uses_connection_note: !!old.uses_connection_note,
    exclude_previous_targets: false,
    exclude_active_targets: false,
    audience_size: 10000,
  };
  if (accountIds.length) body.account_ids = accountIds;
  const r = await aimfox("/campaigns", { method: "POST", body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.campaign?.id) throw new Error(`create campaign ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.campaign;
}

async function pushProfiles(campaignId, profiles) {
  let added = 0, failed = 0;
  const reasons = new Set();
  for (let i = 0; i < profiles.length; i += 10) {
    const chunk = profiles.slice(i, i + 10);
    const payload = {
      type: "profile_url",
      profiles: chunk.map((p) => ({
        profile_url: p.profile_url,
        custom_variables: { company: p.company || "", name: p.name || "" },
      })),
    };
    let ok = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await aimfox(`/campaigns/${campaignId}/audience/multiple`, {
        method: "POST",
        body: JSON.stringify(payload),
      }, 90000);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        reasons.add(`http${r.status}`);
        await sleep(1500);
        continue;
      }
      added += (d?.profiles?.length ?? 0);
      failed += (d?.failed?.length ?? 0);
      for (const v of Object.values(d?.failedReason ?? {})) reasons.add(String(v));
      ok = true;
      break;
    }
    if (!ok) failed += chunk.length;
  }
  return { added, failed, reasons: [...reasons] };
}

const issues = await listIssues();
const contacts = contactsFromIssues(issues);
console.log(`issues=${issues.length} unique_contacts=${contacts.length}`);

const old = await getOldCampaign();
console.log(`old_campaign=${old.id || OLD_ID} name=${old.name} type=${old.outreach_type} state=${old.state} owners=${JSON.stringify(old.owners || [])}`);

const created = await createCampaign(old);
console.log(`new_campaign=${created.id} name=${created.name} state=${created.state} outreach_type=${created.outreach_type}`);

const push = await pushProfiles(created.id, contacts);
console.log(`uploaded=${push.added} failed=${push.failed}` + (push.reasons.length ? ` reasons=${push.reasons.slice(0, 6).join(",")}` : ""));

if (process.env.GITHUB_OUTPUT) {
  await writeFile(process.env.GITHUB_OUTPUT, `new_campaign_id=${created.id}\nuploaded=${push.added}\n`, { flag: "a" });
}
console.log(`CUTOVER_OK new_campaign_id=${created.id}`);
