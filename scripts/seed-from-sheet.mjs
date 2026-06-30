// One-time seeder: builds ../state/seen.json from the legacy Google Sheet so the GitHub-native
// feed doesn't re-file companies/jobs already processed. Run locally once during migration:
//   SHEETS_SA_PATH="/path/to/clickupgex-sheets-sa.json" node scripts/seed-from-sheet.mjs
// Reads column G (Company LinkedIn) and column H (Job URL, whose trailing number is the job id).
import { readFile, writeFile } from "node:fs/promises";
import { createSign } from "node:crypto";

const SHEET_ID = process.env.SHEET_ID || "1WCAsLchLkmTKuK1z9A8037k_cbAW0y8gouCCcQBZsG4";
const TAB = process.env.SHEET_TAB || "Sheet1";
const SA_PATH = process.env.SHEETS_SA_PATH;
if (!SA_PATH) { console.error("set SHEETS_SA_PATH to the service-account json"); process.exit(1); }

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function canonCompanyUrl(u) {
  const m = String(u || "").match(/(https?:\/\/[^/]*linkedin\.com\/company\/[^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}
const jobIdOf = (u) => (String(u || "").match(/jobs\/view\/(\d+)/) || [])[1] || "";

async function token(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const input = `${head}.${claims}`;
  const sig = createSign("RSA-SHA256").update(input).sign(sa.private_key);
  const jwt = `${input}.${b64url(sig)}`;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const j = await r.json();
  if (!j.access_token) throw new Error("token " + JSON.stringify(j));
  return j.access_token;
}

const sa = JSON.parse(await readFile(SA_PATH, "utf8"));
const tok = await token(sa);
const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(TAB)}!A2:H10000`;
const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
const j = await r.json();
const rows = j.values || [];
const companies = new Set(), jobIds = new Set();
for (const row of rows) {
  const cu = canonCompanyUrl(row[6]);
  const jid = jobIdOf(row[7]);
  if (cu) companies.add(cu);
  if (jid) jobIds.add(jid);
}
const out = { updatedAt: "", seededFrom: "legacy Google Sheet", jobIds: [...jobIds].sort(), companies: [...companies].sort() };
await writeFile(new URL("../state/seen.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`seeded ${companies.size} companies, ${jobIds.size} job ids -> state/seen.json`);
