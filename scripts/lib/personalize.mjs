// Writes the Aimfox message variables for one company before its points of contact are pushed.
//
// The Aimfox campaign's messages (set in the Aimfox dashboard) use these custom variables:
//   FIRST_NAME, COMPANY_NAME, HIRING_FOR, TARGET_BUYER, IDEA_1, IDEA_2, IDEA_3 (+ ROLE_SHORT, COMPANY)
// A blank variable makes Aimfox skip the message, so a lead is only pushed when every variable is filled
// and passes the copy gate below. Everything else is held and listed in the run summary.
//
// Writer: OpenAI (OPENAI_MODEL, default gpt-5-nano). Up to two rewrites with the gate's problems, then hold.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Who gets the fractional pitch: companies with 500 or fewer employees (Marielle, 2026-11-13).
export const PERSONALIZE_SIZES = new Set(["1-10", "11-50", "51-200", "201-500"]);

// The live Aimfox messages, rendered by the gate. Keep in sync with the dashboard copy.
const MESSAGES = [
  `{{FIRST_NAME}}, saw {{COMPANY_NAME}} is hiring {{HIRING_FOR}}.

Before you commit to a full-time salary, I could run it fractionally from next week and show you what's worth building.

I was Dreamwell's first SDR and landed Perplexity, their hottest customer, then built Claude Code outbound systems at 3 Clay Partner agencies.

For {{COMPANY_NAME}}, I'd start with:
- {{IDEA_1}}
- {{IDEA_2}}
- {{IDEA_3}}

Should I write the first email I'd send for {{COMPANY_NAME}}, so you can see my approach?

P.S. If this isn't relevant, just tell me.`,
  `{{FIRST_NAME}}, fractional first also means no ramp-up and no fixed payroll.

Send me one job, outbound campaign audit, a verified list of {{TARGET_BUYER}}, for example, or a CRM cleanup.

If it works, your full-time hire inherits a setup that's already proven. If not, you just stop.

Should I scope that list for you?`,
  `{{FIRST_NAME}}, the easiest way to judge outbound help is to see the work.

I can pull 20 {{TARGET_BUYER}}, each with a checked email and a reason they'd care about {{COMPANY_NAME}}.

Want me to send them over?

P.S. If someone else owns this hire, tell me who and I'll reach out to them instead.`,
];

const BANNED_WORDS = "get bank credit access open compare problem now billing deal finance financial claims insurance mortgage soon new performance freedom home sales medical urgent life marketing investment diagnostics friend cash invoice extra purchase free".split(" ");
const BANNED_PHRASES = ["off chance", "one time", "all good", "following up", "great fit", "circle back", "compare notes", "quick question", "quick one", "hope this finds", "checking in", "click", "today", "earn", "discount", "bonus", "guarantee", "promise", "the best", "quote", "trial", "thousands", "unlimited", "immediately", "amazing", "fantastic", "wonderful", "no cost", "no obligation", "no catch", "profits", "increase revenue", "increase sales", "delve", "leverage", "utilize", "streamline", "robust", "empower", "elevate", "seamless", "unlock", "cutting-edge", "game changer", "supercharge", "harness", "transformative"];
const OFF_OFFER = /\b(dials?|dialers?|direct (line|lines|phone|phones)|(phone|mobile) numbers?|mobile enrichment|call (lists?|cards?|scripts?|notes)|callbacks?|voicemails?|callers?|cold call\w*|gatekeeper\w*|sms|texting|text and email|ads?|ad spend|paid (media|social|search|ABM|campaigns?|channels?)|seo|content calendar|social media|web design)\b/i;
const GENERIC = [/^crm (build|cleanup|setup)/, /^targeted lists?\b/, /verified emails?$/, /^ai qualification agents?/, /^sequences for \w+$/,
  /^(an? )?enrichment waterfall$/, /^lead scoring( model)?$/, /^outbound sequences?$/];
const VARS = ["company_name", "role_short", "hiring_for", "target_buyer", "idea_1", "idea_2", "idea_3"];
// Phrases lifted from the offer list read the same for every company (seen in gpt-5-nano tests, 2026-11-13).
const OFFER_ECHO = /\b(prompt evals?|custom scraping|public registers?|verified (list|emails?)|beyond the usual databases|data enrichment|buying signals|angle testing|process mapping|working sessions?|ICP definition)\b/i;
const VAGUE_BUYER = /^(enterprise|b2b|target|potential|key)? ?(buyers|companies|businesses|decision makers|customers|clients|leads|accounts|prospects)\b|\b(scaling|growing|various|tech) (firms|companies)$/i;
// Words that say nothing about a specific company; an idea must share some other word with the post.
const STOP = new Set(("a an the and or of for to in on at by with from into per via your their its our that this these those who which " +
  "list lists build built building target targets targeting account accounts lead leads buyer buyers team teams company companies " +
  "outbound inbound sequence sequences email emails linkedin crm data signal signals hiring posting posts roles role leader leaders " +
  "ranked based using across each every first plus over under more than new").split(" "));
const words = (t) => (String(t).toLowerCase().match(/[a-z0-9][a-z0-9+&'-]*[a-z0-9]|[a-z0-9]/g) || []).map((w) => w.replace(/'s$/, ""));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function render(text, v) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(v[k.toLowerCase()] ?? ""));
}

// Same rules as the hand-review gate (Manna/GTM/campaigns/aimfox-jobs-feed-recopy-2026-11-13/gate.py).
// context: the company + job text the writer saw; when given, every idea must share a distinctive word with it.
export function gate(v, context = "") {
  const p = [];
  const ctx = new Set(words(context).filter((w) => w.length >= 3 && !STOP.has(w)));
  for (const k of VARS) {
    const val = String(v[k] ?? "");
    if (!val.trim()) { p.push(`${k} is empty`); continue; }
    if (/[–—]|\s-\s/.test(val)) p.push(`${k} has a dash`);
    if (/[!"“”;]/.test(val)) p.push(`${k} has ! or quotes or a semicolon`);
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(val)) p.push(`${k} has emoji`);
    if (/\{\{|\}\}/.test(val)) p.push(`${k} contains braces`);
    if (/\b(our|we|us|my)\b|^(Our|We|My)\b/.test(val)) p.push(`${k} uses our/we/us/my: write it from Marielle's side about them (their, its)`);
    if (k.startsWith("idea")) {
      const n = val.trim().split(/\s+/).length;
      if (n > 14 || n < 5) p.push(`${k} is ${n} words, keep 5 to 14`);
      if (val.trim().endsWith(".")) p.push(`${k} ends with a period`);
      const m = val.match(OFF_OFFER);
      if (m) p.push(`${k} offers off-offer work ('${m[0]}'): use lists, email, LinkedIn, CRM, enrichment or reporting`);
      if (GENERIC.some((g) => g.test(val.toLowerCase().trim()))) p.push(`${k} is a generic filler: make it specific to this company`);
      if (/\b(20|pull)\b/i.test(val)) p.push(`${k} repeats the CTA (20 / pull)`);
      const echo = val.match(OFFER_ECHO);
      if (echo) p.push(`${k} copies the offer list ('${echo[0]}'): name what you'd build for THIS company instead`);

    }
  }
  if (String(v.company_name ?? "").length > 22) p.push("company_name over 22 characters");
  if (String(v.role_short ?? "").trim().split(/\s+/).length > 3) p.push("role_short over 3 words");
  const hf = String(v.hiring_for ?? "");
  if (hf && !/^(a|an|its first|its) /.test(hf)) p.push("hiring_for must start with a, an, its first or its");
  if (hf.trim().split(/\s+/).length > 10) p.push("hiring_for over 10 words");
  if (String(v.target_buyer ?? "").trim().split(/\s+/).length > 10) p.push("target_buyer over 10 words");
  if (VAGUE_BUYER.test(String(v.target_buyer ?? "").trim())) p.push("target_buyer is too vague to build a list from: name the role and the kind of company");
  const ideas = [v.idea_1, v.idea_2, v.idea_3].map((x) => String(x ?? "").toLowerCase());
  // Signal-based ideas ("general counsels who changed jobs this quarter") are good without the post's
  // words, so one of three may stand alone; two ungrounded ideas mean the writer ignored the post.
  if (ctx.size && ideas.filter((x) => !words(x).some((w) => ctx.has(w))).length >= 2) {
    p.push("at least two ideas use no specific word from the job post or company description: ground them in their buyer, market, tool or region");
  }
  if (new Set(ideas).size < 3) p.push("ideas repeat");
  const row = { ...v, first_name: "Jane" };
  MESSAGES.forEach((text, i) => {
    const t = render(text, row), low = t.toLowerCase(), toks = new Set(low.match(/[a-z0-9]+/g) || []);
    for (const w of BANNED_WORDS) if (toks.has(w)) p.push(`banned word '${w}' in message ${i + 1}`);
    for (const b of BANNED_PHRASES) if (new RegExp(`\\b${escRe(b)}\\b`).test(low)) p.push(`banned phrase '${b}' in message ${i + 1}`);
    if (/\ba (?!one\b|uni|use|eu)[aeiou]|\ba (SDR|AE|SEO|MBA|[FHLMNRSX][A-Z]+)\b/.test(t)) p.push(`article error in message ${i + 1}: 'an' before a vowel sound`);
    if (/\ban (?!(hour|honest|heir)\b)(?![FHLMNRSX][A-Z0-9&]+\b)[b-df-hj-np-tv-z]/i.test(t.replace(/\ban ([aeiouAEIOU])/g, "AN_OK $1"))) p.push(`article error in message ${i + 1}: 'a' before a consonant sound`);
    if (i === 0) {
      const words = (t.match(/[\w$'@&.+,-]+/g) || []).length;
      if (words > 125) p.push(`message 1 is ${words} words, max 125: shorten the ideas or hiring_for`);
    }
  });
  return [...new Set(p)].sort();
}

// "Dr. Jane (JJ) Doe, MBA 🚀" -> "Jane". Returns "" when no usable first name is left.
export function firstNameOf(fullName) {
  let s = String(fullName || "").normalize("NFKC")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\(.*?\)|\[.*?\]|".*?"/g, " ")
    .split(",")[0].trim();
  s = s.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, "");
  const first = (s.split(/\s+/)[0] || "").replace(/\.$/, "");
  if (!/^\p{L}[\p{L}'-]+$/u.test(first)) return "";
  return first === first.toLowerCase() || first === first.toUpperCase()
    ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : first;
}

// Full LinkedIn job description via the public guest endpoint. Empty string when blocked.
export async function linkedinJobDescription(jobId) {
  if (!jobId) return { desc: "", closed: false };
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(8000 * a); continue; }
      if (!r.ok) return { desc: "", closed: false };
      const html = await r.text();
      const m = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/);
      const desc = m ? m[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, "\"").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim() : "";
      return { desc: desc.slice(0, 7000), closed: html.includes("No longer accepting applications") };
    } catch { await sleep(3000 * a); }
  }
  return { desc: "", closed: false };
}

const SYSTEM_PROMPT = `You write the per-company personalization for a LinkedIn message sequence Marielle sends to people at companies hiring a GTM engineer (or GTM ops / GTM strategy role). Nobody checks your wording before it is sent, so write every variable as if Marielle typed it.

Marielle's offer: she is a freelance outbound and GTM engineer. Before the company commits to a full-time salary for this role, she runs the work fractionally from next week and shows them what's worth building. Proof: Dreamwell's first SDR (landed Perplexity), then built Claude Code outbound systems at 3 Clay Partner agencies.
What she delivers (nothing else): prospect research and list building, including audiences beyond the usual databases via custom scraping (Google Maps, directories, public registers, job boards, event lists); data enrichment and verified emails; buying signals (hiring, funding, tech stack, leadership changes, permits, registrations); AI qualification and research agents in Clay, OpenAI or Claude, with prompt evals before a full run; cold email and LinkedIn sequences and angle testing; sending domains, mailboxes, warmup and DNS checks; automation and reporting (Make.com, Trigger.dev, Supabase workflows, enrichment tables, live dashboards); CRM build, cleanup and routing (HubSpot, Attio); SOPs, process mapping and team training.
She never offers: phone numbers, direct dials, dialers, call lists, call scripts, making calls, SMS, paid ads, SEO, content or social media, web design.

Message 1 reads:
"<first_name>, saw <company_name> is hiring <hiring_for>.
Before you commit to a full-time salary, I could run it fractionally from next week and show you what's worth building.
I was Dreamwell's first SDR and landed Perplexity, their hottest customer, then built Claude Code outbound systems at 3 Clay Partner agencies.
For <company_name>, I'd start with:
- <idea_1>
- <idea_2>
- <idea_3>
Should I write the first email I'd send for <company_name>, so you can see my approach?"
Later messages say "a verified list of <target_buyer>" and "I can pull 20 <target_buyer>, each with a checked email and a reason they'd care about <company_name>."

VERDICT. "keep" only when the role is GTM engineering, GTM/revenue ops, outbound or pipeline generation, B2B demand gen, or growth work about B2B pipeline or GTM tooling, AND the company sells to businesses or professionals with budgets.
"exclude" (one-line reason) when ANY is true: growth role that is product engineering, paid ads, SEO, content or consumer growth; recruiter or staffing firm posting for an unnamed client; buyers are cybersecurity/infosec or physical security teams; sells medical, insurance, lending, mortgage, gambling or adult products to consumers, or its buyers are consumers, students, job seekers or creators; the company itself sells AI outbound, SDR agents, cold email or lead generation services; too thin to tell what it sells or to whom.

VARIABLES (keep only):
- company_name: how they say it in conversation, max 22 characters; drop Inc, Ltd, GmbH, ".com", and an "AI" suffix when it reads fine without.
- role_short: 1 to 3 words, e.g. "GTM engineer", "founding GTM engineer", "RevOps lead".
- hiring_for: completes "saw X is hiring ___". Starts with "a", "an", "its first" or "its". Under 10 words. Use the post's framing, e.g. "a GTM engineer to build outbound from scratch". Say "first" only if the post says first or founding.
- target_buyer: plural, the people or companies THIS company sells to, specific enough to build a list from, under 10 words. Not "B2B companies", not "decision makers".
- idea_1, idea_2, idea_3: three things Marielle would build first for this company. Each a noun phrase naming a concrete deliverable, 6 to 14 words, no final period, lowercase start unless a proper noun or acronym. Each must hang on something specific in the job post or company description (their buyer, market, vertical, motion, named tool, region, stage). At least one is a target list defined by a real, findable signal (job posts, funding, tech stack, a public register or directory, conference exhibitors, leadership changes). Portability test: if the idea would make sense for a different company, rewrite it. Never mention "20" or "pull", never propose using their own product, nothing from the never-offers list. Never invent facts not in the input.

HARD WRITING RULES. Never use these words, alone or inside a compound: get, bank, credit, access, open, compare, problem, now, billing, deal, finance, financial, claims, insurance, mortgage, soon, new, performance, freedom, home, sales, medical, urgent, life, marketing, investment, diagnostics, friend, cash, invoice, extra, purchase, free ("sales team" -> "revenue team" or "AEs"; "marketing team" -> "demand gen team"; "Salesforce" -> "your CRM"). Never use: leverage, streamline, robust, seamless, unlock, empower, elevate, delve, utilize, cutting-edge, supercharge, harness, transformative, guarantee, promise, the best, today, click, earn, bonus, quote, trial. No dashes, exclamation marks, quotes, semicolons or emoji. "an" before a vowel sound. Keep casing of tools and acronyms (HubSpot, Clay, LinkedIn, GTM, B2B, SaaS, RevOps, ICP).

Example. BuyerSight, hiring a Senior GTM Engineer. target_buyer "B2B founders who need meetings but have no SDR team". Ideas: "agents that research each account and draft the first line, with a human check" / "prompt evals on 50 rows before a prompt runs on a full list" / "one shared Clay build, so a fix reaches every customer at once".
Example. Tulip, hiring a senior RevOps manager. target_buyer "plant operations leaders at multi-site manufacturers". Ideas: "a TAM model of manufacturers sized by plant count and MES in use" / "manufacturers posting MES, continuous improvement or digital transformation roles" / "a lead score built on plant count, MES vendor and hiring signals".

HOW TO WRITE THE IDEAS. First list in "facts" 4 to 6 specifics copied from the input: who they sell to, their market or vertical, named tools or stack, regions, numbers, the motion the post describes. Then build each idea on one of those facts, reusing its words. An idea that would read the same for another company is wrong. Do not repeat the offer list's wording ("prompt evals", "custom scraping", "public registers", "verified list") as an idea.
Write about them in the third person: "its", "their". Never "our", "we" or "us" (copying the post's "our team" is wrong).

Return JSON only: {"facts":[""],"verdict":"keep"|"exclude","reason":"","company_name":"","role_short":"","hiring_for":"","target_buyer":"","idea_1":"","idea_2":"","idea_3":""}`;

async function callOpenAI(key, model, messages) {
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        // gpt-5-nano spends tokens on reasoning first; a low cap returns an empty answer.
        body: JSON.stringify({ model, messages, response_format: { type: "json_object" }, max_completion_tokens: 16000,
          ...(/^(gpt-5|o\d)/.test(model) ? { reasoning_effort: "medium" } : { temperature: 0.4 }) }),
        signal: AbortSignal.timeout(180000),
      });
      if (r.status === 429 || r.status >= 500) { await sleep(5000 * a); continue; }
      const j = await r.json();
      if (!r.ok) throw new Error(`openai ${r.status} ${j?.error?.message || ""}`.slice(0, 200));
      return JSON.parse(j.choices?.[0]?.message?.content || "{}");
    } catch (e) {
      if (a === 3 || /openai 4\d\d/.test(String(e.message))) throw e;
      await sleep(3000 * a);
    }
  }
  return {};
}

// input: { companyName, title, location, size, industry, about, specialties, jobSummary, jobDescription }
// returns { ok: true, vars } or { ok: false, reason }. Two rewrites with the gate's problems, then held.
export async function writeVariables(input, { key, model = "gpt-5-nano" } = {}) {
  if (!key) return { ok: false, reason: "no OPENAI_API_KEY" };
  const facts = [
    `Company: ${input.companyName}`,
    `Size: ${input.size} employees`,
    input.industry ? `Industry: ${input.industry}` : "",
    input.specialties ? `Specialties: ${input.specialties}` : "",
    input.about ? `About the company: ${String(input.about).slice(0, 2000)}` : "",
    `Job title: ${input.title}`,
    `Location: ${input.location}`,
    input.jobDescription ? `Job description: ${input.jobDescription}` : (input.jobSummary ? `Job summary: ${input.jobSummary}` : ""),
  ].filter(Boolean).join("\n");
  if (!input.jobDescription && !input.jobSummary && !input.about) return { ok: false, reason: "no job description or company description" };
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: facts }];
  let out = await callOpenAI(key, model, messages);
  for (let round = 0; round < 3; round++) {
    if (out.verdict === "exclude") return { ok: false, reason: `excluded: ${out.reason || "no reason given"}` };
    const vars = Object.fromEntries(VARS.map((k) => [k, String(out[k] ?? "").trim()]));
    const problems = gate(vars, facts);
    if (!problems.length) return { ok: true, vars };
    if (round === 2) return { ok: false, reason: `copy gate: ${problems.slice(0, 3).join("; ")}` };
    messages.push({ role: "assistant", content: JSON.stringify(out) });
    messages.push({ role: "user", content: `Fix every problem and return the full JSON again:\n- ${problems.join("\n- ")}` });
    out = await callOpenAI(key, model, messages);
  }
  return { ok: false, reason: "unreachable" };
}
