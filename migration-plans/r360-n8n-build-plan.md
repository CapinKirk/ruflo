# R360 Lead Inbound: Zapier → n8n Build Plan (Verified, Compiled, UAT-Baked)

**Author:** Kirk Bennett · **Generated:** 2026-05-10 · **Last revised:** 2026-05-10 (verification swarm + UAT bake-out)

**Source:** `~/Downloads/full_config_r360_requested_zaps_with_warning.json`, plus uncensored Zap exports for `316701470`, `332679789`, `336544812`, `225753704`.

**Goal:** Replace 7 R360 Zaps in n8n with **zero data loss**, full feature parity, comprehensive SF UAT verification, and a reconciliation safety net guaranteeing no inbound submission is ever silently dropped.

**Companion deep-spec:** `migration-plans/specs/spec_316797554.md` (1,118 lines — every node, branch, field map, code block).

---

## 0. What changed since the last revision

The prior 833-line plan was scoped to 4 zaps and was 70% complete. A 3-agent verification swarm (gap-analysis, cross-spec sweep, technical feasibility) plus an explicit UAT bake-out closed the gaps. Highlights:

- **+3 in-scope zaps:** SocialIntents R360 branch (332679789 Path K), R360 Pre-Discovery (336544812), R360 FAQ (225753704). The R360 central processor has **4 feeders, not 3** — the bot's R360 path POSTs to the same `utwbkbm` URL.
- **+8 spec gaps closed:** ReQuery sub-tree, CampaignMember field maps, hardcoded SF ID inventory (22 IDs), 5 email templates, 12 per-action error branches, 4 missing failure modes, Convert Lead via HTTP node, Case RT clarification.
- **+3 architecture corrections from feasibility report:**
  1. WordPress DB polling replaces unverified WPForms REST API endpoint.
  2. HTTP Request node replaces n8n's native SF node for `convertLead` (no native support).
  3. Empty-key filter Set node before every SF Update (n8n SF node overwrites blanks otherwise).
- **+1 dedicated SF UAT day (Day 0):** environment prep, UAT-vs-Prod ID mapping, test data factory seeding.
- **+16 component test cases (C-1 to C-16)** with pre/post SOQL assertions.
- **+6 load tests (L-1 to L-6)** for steady-state, spikes, sustained 10× volume, race conditions, round-robin distribution, Pre-Discovery concurrency.
- **+3 sign-off gates:** Code Review, Functional UAT, 72h Parity — each with named owners and pass criteria.
- **+1 production daily UAT procedure** (3-query SOQL audit + Slack verdict).
- **+1 explicit rollback criteria table** with 6 triggers.

Estimated effort: **7 days of focused engineering + 72h dual-write soak + 14-day post-cutover monitoring**.

---

## 1. Final scope — 7 R360 Zaps

| # | Zap ID | Title | Role | Phase |
|---|---|---|---|---|
| 1 | 316698017 | [R360] Watch a Video — WPForms | Router → central | 1A |
| 2 | 316701470 | [R360] Get a Demo Form — WPForms | Router → central | 1A |
| 3 | 316797350 | [R360] Contact Form — WPForms | Router → central | 1A |
| 4 | **316797554** | **[R360] WPForm: Process Submissions** | **Central processor (116 nodes, 4-path tree, 12 SF writes)** | 1A |
| 5 | 332679789 (Path K only) | Bot Book A Demo — R360 branch | SocialIntents "Rena Record" / "Rosie" personas → POSTs to `utwbkbm` | 1B |
| 6 | 336544812 | R360 Pre-Discovery AI Notes | Webhook → Perplexity sonar-deep-research + Apollo + GPT-5.1 → SF Contact `Record360_AI_Contact_Brief__c` + Slack DM | 1B |
| 7 | 225753704 | Record360 FAQ | WPForm 33076 (FAQ form) → Google Sheet — non-SF, low priority | 1C |

**Confirmed off / not in scope:** 314287758, 314429781, 320314965, 331836660, 343296525 — all `status: off` in the Zapier export.

**No active downstream R360 consumers.** Verified by grepping for `R360_Record__c` and `RecordTypeId = 012Ki000000bpgRIAQ` in active Zaps — only Zap 316797554 writes those values; nothing reads them via SF triggers in Zapier (downstream automation lives in SF Apex / Flow, which is unaffected).

**Why this matters:** every miss is revenue lost. R360 leads land in the Salesforce org with `R360_Record__c = true`, route to a region-specific AE, get tagged into Pardot campaigns, and trigger SDR/AM follow-up. A silent failure shows up weeks later as a missed deal.

---

## 2. Architecture corrections from feasibility report

These three corrections override the prior plan's assumptions and apply to all sections below.

### 2.1 Reconciliation pattern (replaces prior §5.2 entirely)

- **Real-time** delivery: WPForms Webhook addon on R360 WordPress (or native n8n WPForms Trigger node) → n8n receiver. Per WPForms docs the Webhook addon includes the entry ID, which we hash for idempotency.
- **Reconciliation polling:** every 10 minutes, n8n queries the WordPress database directly via the `wp_wpforms_entries` table. This bypasses the unverified `/wp-json/wpforms/v1/forms/{id}/entries` REST endpoint. Requires read-only DB credentials for n8n.
- The `Lead_Inbound_Log__c.Idempotency_Hash__c` upsert is unchanged — `sha256(form_id + ":" + wp_entry_id)`.

### 2.2 Lead conversion (replaces prior plan mention of Zap node 340057313)

- n8n's native Salesforce node does NOT support `convertLead`.
- Build a small `sub-convert-lead.json` that uses the HTTP Request node to call `POST /services/data/v62.0/sobjects/LeadConvert/` with the OAuth credential already bound to the SF node. ~30 lines.
- Parameters from Zap 340057313: `convertedStatus = "Qualified"`, `doNotCreateOpportunity = false` (Zap had `create_opportunity: Yes`), `accountId = 0014u00002BFXvRAAX` (NA Account — note bug: hardcoded regardless of region).
- **Bug fix during migration:** route the Account ID by region using the same Assignment Owner code's `LeadAccountId` output, not the hardcoded NA value.

### 2.3 SF Update partial-field handling (NEW guidance applied to all paths)

- Zap pattern of `LastName: ""` to "leave existing" does NOT translate. n8n SF node will overwrite with empty string.
- Insert a Set node BEFORE every SF Update call that drops keys with empty/null values:
  ```js
  for (const k of Object.keys(payload)) {
    if (payload[k] === "" || payload[k] == null) delete payload[k];
  }
  ```
  Or use a Code node.
- This is tested explicitly as **C-9** in the UAT component matrix and **T21** in the integration matrix.

### 2.4 SOQL injection fix (correction to §6.3)

- The `Create Queries` Code node interpolates strings directly into SOQL. Submitter-controlled `companyName` with `'` breaks the query.
- Add escape: `const esc = (s) => String(s ?? '').replace(/'/g, "\\'");` and use `esc(companyName)`, `esc(longestWord)` etc. Patch shown inline in §6.3 below.

---

## 3. WPForms Field-ID Reference (per form — receivers normalize at the boundary)

WPForms field IDs differ between forms. The receivers map raw `field<N>` keys to semantic names BEFORE handing the payload to the shared resolver. Captured verbatim from the uncensored Zap exports.

| Logical field | 29710 (Contact Form) | 29712 (Watch Video) | 29714 (Get a Demo) |
|---|---|---|---|
| BusinessEmail | `field13` | `field7` | `field7` |
| FirstName | `field2` | — | — |
| LastName | `field3` | — | — |
| CompanyName | `field5` | — | — |
| PhoneNumber | `field7` | — | — |
| YourIndustry | `field6` | — | — |
| YourRegion | `field14` | — | — |
| utmSource | `field8` | — | — |
| utmMedium | `field9` | — | — |
| utmCampaign | `field10` | — | — |
| utmTerm | `field11` | — | — |
| utmContent | `field12` | — | — |
| gclid | `field17` | `field10` | `field10` |
| fbc | `field18` | `field11` | `field11` |
| fbp | `field19` | `field12` | `field13` |
| msclkid | `field20` | `field13` | `field14` |
| ROIcalculator | `field26` | — | — |

> Note that fbp + msclkid are at different field numbers between Watch Video (12/13) and Get a Demo (13/14). Watch Video and Get a Demo do not capture name/company/phone/UTMs — only email + 4 click IDs. The Contact Form captures the full set.

The Zapier WPForms credential ID `58031418` is a Zapier-internal pointer, not the credential value. n8n receivers will use a separate WPForms credential bound at deploy time per environment (UAT vs prod).

---

## 4. The 4-Feeder → 1-Processor topology

### 4.1 Today (Zapier)

```
WPForm 29710 (Contact Form) ─┐
WPForm 29712 (Watch Video)  ─┤
WPForm 29714 (Get a Demo)   ─┼─► hooks.zapier.com/.../utwbkbm/
SocialIntents Bot R360 path ─┘                     │
   (Zap 332679789 Path K)                          ▼
                                       Zap 316797554 (central processor)
                                       116 nodes, 4-path tree
                                                   │
                                                   ▼
                                       Salesforce + Slack + Gmail
```

**Feeder payload contract** (what each feeder POSTs to the central catch URL):

| Field | Watch Video | Get a Demo | Contact Form | Bot R360 (Path K) |
|---|---|---|---|---|
| `Timestamp` | `{{zap_meta_human_now}}` | `{{zap_meta_human_now}}` | `""` *(bug)* | bot timestamp |
| `ZapID` | `"316698017"` | `"316701470"` | `""` *(bug)* | `"332679789"` |
| `WPFormName` | `"WatchVideo"` | `"GetADemo"` | `"ContactForm"` | `"BotBookADemo"` |
| `BusinessEmail` | ✓ field7 | ✓ field7 | ✓ field13 | bot-collected |
| `FirstName` | — | — | ✓ field2 | bot-collected |
| `LastName` | — | — | ✓ field3 | bot-collected |
| `CompanyName` | — | — | ✓ field5 | bot-collected |
| `PhoneNumber` | — | — | ✓ field7 | bot-collected |
| `YourIndustry` | — | — | ✓ field6 | bot-collected |
| `YourRegion` | — | — | ✓ field14 | bot-collected |
| `utm*` | — | — | ✓ field8/9/10/11/12 | bot-collected (when present) |
| `gclid/fbc/fbp/msclkid` | ✓ | ✓ | ✓ | ✓ (when present) |
| `ROIcalculator` | — | — | ✓ field26 | — |
| `note` | — | — | — | ✓ chat transcript |
| `requestedTime` | — | — | — | ✓ |
| `requestedTimeZone` | — | — | — | ✓ |
| `MQLdate` | — | — | — | ✓ |
| **Delay before POST** | **15 min** | **15 min** | **immediate** | **immediate** |

> **Critical observation:** Watch Video and Get a Demo only send email + click IDs. The central processor must NOT use lastName-fuzzy-match for those — there's no name to match on. Use email-only matching when `WPFormName ∈ {"WatchVideo","GetADemo"}`. The `pick()` helper in the Text Formatter FN already accepts the bot-specific extras (`note`, `requestedTime`, `requestedTimeZone`, `MQLdate`).

### 4.2 Tomorrow (n8n)

```
WPForm 29710 ─► n8n /webhook/r360/contact-form  ─┐
WPForm 29712 ─► n8n /webhook/r360/watch-video    ─┤
WPForm 29714 ─► n8n /webhook/r360/get-demo       ─┼─► [Sub-Workflow: R360 Resolver]
SocialIntents R360 branch ─► /webhook/r360/bot   ─┘            │
                                                                ▼
                          Lead_Inbound_Log__c (SF) — every payload logged first
                                                                │
                                                                ▼
                          Normalize → Find Lead/Contact → Branch (4 paths + ReQuery sub-tree) → Write SF + Notify
```

**Why no router intermediate step in n8n?** Today's router-then-processor pattern in Zapier exists because Zapier's WPForms trigger doesn't expose `WPFormName` directly — they had to hand-roll it in a router POST. n8n receives the WPForms webhook directly, knows the form ID, and can set `WPFormName` itself.

**The 15-minute delay** for Watch Video and Get a Demo: replicate as an n8n `Wait 15 minutes` node at the start of those two receivers ONLY. Confirm with Marketing whether the delay is still needed. If kept, mark "configurable" so it can be toggled off without redeploy.

---

## 5. The R360 Processor Sub-Workflow

### 5.1 Inputs

```json
{
  "source": "wpform_29710 | wpform_29712 | wpform_29714 | bot_r360",
  "WPFormName": "ContactForm | WatchVideo | GetADemo | BotBookADemo",
  "wpformsEntryId": "<numeric WPForms entry id OR bot conversation id>",
  "BusinessEmail": "...",
  "FirstName": "...",     // (optional — only Contact Form / bot has it)
  "LastName": "...",      // (optional)
  "CompanyName": "...",   // (optional)
  "PhoneNumber": "...",   // (optional)
  "YourIndustry": "...",  // (optional)
  "YourRegion": "...",    // (optional, drives region routing)
  "utmSource": "...", "utmMedium": "...", "utmCampaign": "...",
  "utmTerm": "...", "utmContent": "...",
  "gclid": "...", "fbc": "...", "fbp": "...", "msclkid": "...",
  "ROIcalculator": "...", // (Contact Form only)
  "note": "...",          // (bot only)
  "requestedTime": "...", // (bot only)
  "requestedTimeZone": "...",
  "MQLdate": "..."        // (bot only)
}
```

### 5.2 Step-by-step (mirrors Zap 316797554)

| # | n8n Node | Purpose | Source Zap node |
|---|----------|---------|-----------------|
| 1 | **SF Upsert: `Lead_Inbound_Log__c`** | Idempotency hash; if already exists with `Status__c='written'` → exit early as `replayed_duplicate` | NEW |
| 2 | **IF: `email_present`** | Skip if no email; mark log `X_skipped_no_email` | 316965885 |
| 3 | **Code: `Text Formatter FN`** | Normalize first/last/company/email; map UTM → LeadSource; map region → billingCountry; clean landing URL | **316797556** (§6.1) |
| 4 | **Code: `Create Partial Account Name`** | Extract longestWord/wordBefore/wordAfter from company | **316797557** (§6.2) |
| 5 | **Code: `Create Queries`** | Build SOQL: gmail/yahoo → match by company; corporate → match by email-domain. **With SOQL injection escape fix.** | **316965886** (§6.3) |
| 6 | **SF Find: Lead** | SOQL: `email = ? AND LastName LIKE '%?%' AND IsConverted = false` | 318022711 |
| 7 | **SF Find: Contact** | SOQL: `email = ? AND LastName LIKE '%?%'` | 318022712 |
| 8 | **Code: `Assignment Owner`** | Region → InsideSalesQueue + Owner + LeadAccountId + NotificationEmail (hardcoded for 6 regions) | **316797562** (§6.4) |
| 9 | **Code: `Formatted Current Date`** | today as `Lead_Override_Date__c` | 316797563 |
| 10 | **SF Find: Account** | If Contact found, query Account.Status__c (Customer vs not) | 316797561 |
| 11 | **Switch: Initial 4-path** | Route on (LeadFound? ContactFound? Account.Status==Customer?) | 316797564 |
| 12 | **ReQuery sub-tree (Path A)** | If neither Lead nor Contact found, wait 15s and re-find. See §5.3. | 316797568+ |
| 13a | **Path A4a** — Lead found via requery → update Lead | Similar to Path B | 316797638 |
| 13b | **Path A4b** — Still no record → CREATE Lead (the "real" Path A) | New SF Lead + Campaign Member | 316797589 + 334669861 |
| 13c-i | **Path A4c-i** — Contact found via requery, NOT customer → update Contact + Case (uses node 316797607 — the `/f` prefix bug) | Similar to Path C (creates Case) | 316797607 |
| 13c-ii | **Path A4c-ii** — Contact found via requery, IS customer | Similar to Path C | 316797625 + 316797628 |
| 13d | **Path A4d** — "End For Short Form" terminal 1-min wait, no further action | Watch Video / Get a Demo no-name fallback | 319542862, 319542863 |
| 14a | **Path B** — Update Lead (initial Lead found, no Contact) | Update SF Lead + Campaign Member | 316797571 + 316797574 |
| 14b | **Path C** — Update Contact, AM (Contact + Customer) | Update Contact + Create Case, route to AM | 316797656 + 316797659 |
| 14c | **Path D** — Update Contact, SDR (Contact, not Customer) | Update Contact, no Case | 316797669 |
| 15 | **SF Update: `Lead_Inbound_Log__c`** | Set Status, Decision_Path, Resolved_*, n8n_Execution_Id | NEW |
| 16 | **Slack DM** | Notify assigned AE/SDR via `User.Slack_ID__c` lookup | NET-NEW (no per-path Slack DMs exist in Zap 316797554 — see DRIFT-8) |
| 17 | **Gmail (SMTP)** | Send notification email per region (NotificationEmail from step 8). Templates in §7.7. | 316797672 etc. |

### 5.3 ReQuery 15-second sub-tree under Path A

After the initial Find Lead + Find Contact return empty, the central processor runs:

- **Wait 15 sec** (node 316797568) — give SF replication a moment to land any Lead/Contact created by other automations during the same submission
- **Re-Find Lead** (node 316797569 → 316797570 "ReQuery Worked Lead")
- **Re-Find Contact** (node 316797588 "ReQuery Did not Work" / 316797602 "ReQuery Worked Contact")
- Branch into 5 sub-paths:
  - **A4a** Lead found after requery → update Lead (similar to Path B, see §7.2)
  - **A4b** Still no record → CREATE Lead (the original Path A — node 316797589, see §7.1)
  - **A4c-i** Contact found after requery, NOT customer → update Contact + Case (similar to Path C, but uses node 316797607 — the one with the `/f` prefix bug on `fbp__c`)
  - **A4c-ii** Contact found after requery, IS customer → update Contact + Case (similar to Path C)
  - **A4d** "End For Short Form" — terminal 1-min wait, no further action (node 319542863, 319542862)

### 5.4 Path A special case — the R360 "Contact Form should never create a Lead" rule

From filter 316797565:
- If `WPFormName === "ContactForm"` AND no Lead AND no Contact → **STOP, do not create.**
- Rationale: Contact Form is for existing customers reaching out; no record means a typo or junk submission.
- Implement: in the n8n Switch node's Path A condition, add `AND WPFormName != "ContactForm"`. Otherwise route to a 5th terminal path that just logs `X_no_record_skipped_contactform` and exits.

---

## 6. Code Nodes (verbatim from Zap, with corrections)

### 6.1 `Text Formatter FN` (316797556)

Inputs (n8n bindings):
```js
{
  firstNameInput: "{{ $json.FirstName }}",
  lastNameInput:  "{{ $json.LastName }}",
  companyNameInput: "{{ $json.CompanyName }}",
  emailInput:     "{{ $json.BusinessEmail }}",
  CRO1: "{{ $json.field40 }}",
  CRO2: "{{ $json.field39 }}",
  LandingPage: "{{ $json.field26 }}",
  source: "{{ $json.utmSource }}",
  regionInput: "{{ $json.YourRegion }}",
  utmCampaign: "{{ $json.utmCampaign }}",
  utmTerm:     "{{ $json.utmTerm }}",
  utmContent:  "{{ $json.utmContent }}",
  utmMedium:   "{{ $json.utmMedium }}",
  industry:    "{{ $json.YourIndustry }}",
  phone:       "{{ $json.PhoneNumber }}",
  roiCalculator: "{{ $json.ROIcalculator }}",
  // bot-only extras (passed through, accepted by pick() helper):
  note:              "{{ $json.note }}",
  requestedTime:     "{{ $json.requestedTime }}",
  requestedTimeZone: "{{ $json.requestedTimeZone }}",
  MQLdate:           "{{ $json.MQLdate }}"
}
```

Code (port verbatim — already JS):
```js
function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const v = obj[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
  }
  return fallback;
}

const rawFirstName = pick(inputData, ["firstNameInput","FirstName","firstName","First Name"], "");
const rawLastName  = pick(inputData, ["lastNameInput","lastName","LastName","last_name","Last Name"], "");
const rawCompany   = pick(inputData, ["companyNameInput","companyName","CompanyName","company","Company Name"], "");
const rawRegion    = pick(inputData, ["regionInput","region","Region"], "");
const rawEmail     = pick(inputData, ["emailInput","Business Email","businessEmail","BusinessEmail","email","Email"], "");
const rawSource    = pick(inputData, ["source","utmSource","utm_source","UTM Source","Page UTM Source"], "");
const rawPhone     = pick(inputData, ["phone","Phone"], "");
const rawIndustry  = pick(inputData, ["industry","Industry"], "");
const rawCRO1      = pick(inputData, ["CRO1","cro1"], "");
const rawCRO2      = pick(inputData, ["CRO2","cro2"], "");
const roiCalc      = inputData.roiCalculator;
const rawUtmCampaign = pick(inputData, ["utmCampaign","UTM Campaign"], "");
const rawUtmTerm     = pick(inputData, ["utmTerm","UTM Term"], "");
const rawUtmContent  = pick(inputData, ["utmContent","UTM Content"], "");
const rawUtmMedium   = pick(inputData, ["utmMedium","UTM Medium"], "");

function getLeadSource(source) {
  const websiteSource = String(source).toLowerCase();
  if (websiteSource.includes("adwords") || websiteSource.includes("google") || websiteSource.includes("bing")) return "AdWords";
  if (websiteSource.includes("natural") || websiteSource.includes("offline")) return "Marketing: Organic";
  if (websiteSource.includes("email")) return "Email marketing";
  return "Marketing: Organic";
}

function getBillingCountry(region) {
  switch (region) {
    case "North America":
    case "South America": return "United States";
    case "Europe":        return "United Kingdom";
    case "Australia & New Zealand": return "Australia";
    default: return "United States";
  }
}

function stringFormatter(s) {
  if (!s) return "";
  return String(s)
    .replace(/Á|Ä|À|Ã|Â/gi,"A").replace(/É|Ë|È|Ê/gi,"E")
    .replace(/Í|Ï|Ì|Î/gi,"I").replace(/Ó|Ö|Ò|Õ|Ô/gi,"O")
    .replace(/Ú|Ü|Ù|Û/gi,"U").replace(/ñ/gi,"n").replace(/ç/gi,"c")
    .replace(/[^a-zA-Z0-9@.\-_ \n]/g,"");
}

const emailFormatter = (e) => e ? String(e).replace(/[^a-zA-Z0-9@.\-_]/g,"") : "";
const extractDomain = (e) => { const x = String(e||""); return x.includes("@") ? x.substring(x.lastIndexOf("@")+1) : ""; };

let fName = stringFormatter(rawFirstName);
let lName = stringFormatter(rawLastName);
let cName = stringFormatter(rawCompany);
let email = rawEmail ? emailFormatter(rawEmail) : "NoEmailProvided@invalid.email";

if (!fName.trim()) fName = "NoFirstNameProvided";
if (!lName.trim()) lName = "NoLastNameProvided";
if (!cName.trim()) cName = "NoCompanyNameProvided";

const emailDomain = extractDomain(email);
const leadSource = rawSource ? getLeadSource(rawSource) : "Marketing: Organic";
const billingCountry = getBillingCountry(rawRegion);

const getBaseUrl = (url) => {
  if (!url) return "";
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; }
  catch { return String(url).split(/[?#]/)[0]; }
};
const landingKey = inputData.LandingPage !== undefined ? "LandingPage"
                  : inputData.landingPage !== undefined ? "landingPage"
                  : inputData["Landing Page"] !== undefined ? "Landing Page" : null;
const cleanedLanding = landingKey ? getBaseUrl(inputData[landingKey]) : "";

return [{
  formattedFirst: fName,
  formattedLast: lName,
  formattedCompany: cName,
  formattedEmail: email,
  emailDomain,
  phone: rawPhone,
  formattedIndustry: rawIndustry,
  roiCalculator: roiCalc,
  utmsource: leadSource,
  utmCampaign: rawUtmCampaign,
  utmTerm: rawUtmTerm,
  utmContent: rawUtmContent,
  utmMedium: rawUtmMedium,
  formattedRegion: rawRegion,
  formattedCountry: billingCountry,
  CRO1: rawCRO1,
  CRO2: rawCRO2,
  ...(landingKey ? { [landingKey]: cleanedLanding } : {})
}];
```

### 6.2 `Create Partial Account Name` (316797557)

```js
function extractCoreWords(companyName) {
  const stopWords = new Set([
    'a','an','the','of','and','in','on','at','for','with',
    'co','corp','inc','llc','ltd','company','services'
  ]);
  if (!companyName || typeof companyName !== 'string') {
    return { longestWord: null, wordBefore: null, wordAfter: null };
  }
  const filteredWords = companyName.trim().split(/\s+/).filter(word => {
    const cleanWord = word.toLowerCase().replace(/[^a-z0-9]/gi,'');
    return cleanWord && !stopWords.has(cleanWord);
  });
  if (filteredWords.length === 0) return { longestWord: null, wordBefore: null, wordAfter: null };
  let longestIdx = 0;
  for (let i = 1; i < filteredWords.length; i++) {
    if (filteredWords[i].length > filteredWords[longestIdx].length) longestIdx = i;
  }
  return {
    longestWord: filteredWords[longestIdx],
    wordBefore: longestIdx > 0 ? filteredWords[longestIdx-1] : null,
    wordAfter:  longestIdx < filteredWords.length-1 ? filteredWords[longestIdx+1] : null
  };
}

const r = extractCoreWords(inputData.companyName);
return { longestWord: r.longestWord, wordBefore: r.wordBefore, wordAfter: r.wordAfter };
```

### 6.3 `Create Queries` (316965886) — smart SOQL builder *(SOQL injection fixed)*

```js
let { firstName, lastName, email, emailDomain, companyName, longestWord } = inputData;
let wordBefore = inputData.wordBefore ?? '';
let wordAfter = inputData.wordAfter ?? '';

// SOQL injection fix: escape single quotes before interpolation
const esc = (s) => String(s ?? '').replace(/'/g, "\\'");

const publicDomains = new Set([
  'gmail.com','yahoo.com','hotmail.com','aol.com','outlook.com',
  'icloud.com','msn.com','live.com','protonmail.com',
  'zoho.com','yandex.com','mail.com'
]);

let contactQuery, leadQuery;

if (publicDomains.has(String(emailDomain).toLowerCase())) {
  // Public email (gmail.com etc.) — match on company name (exact OR fuzzy 3-word)
  contactQuery = `Email = '${esc(email)}' AND (Account.Name = '${esc(companyName)}' OR (Account.Name LIKE '%${esc(wordBefore)}%' AND Account.Name LIKE '%${esc(longestWord)}%' AND Account.Name LIKE '%${esc(wordAfter)}%'))`;
  leadQuery    = `Email = '${esc(email)}' AND (Company = '${esc(companyName)}' OR (Company LIKE '%${esc(wordBefore)}%' AND Company LIKE '%${esc(longestWord)}%' AND Company LIKE '%${esc(wordAfter)}%')) AND IsConverted = False`;
} else {
  // Corporate email — match on email domain + first/last name + company
  contactQuery = `Email_Domain__c = '${esc(emailDomain)}' AND (Email LIKE '%${esc(firstName)}%' OR Email LIKE '%${esc(lastName)}%') AND (Account.Name = '${esc(companyName)}' OR (Account.Name LIKE '%${esc(wordBefore)}%' AND Account.Name LIKE '%${esc(longestWord)}%' AND Account.Name LIKE '%${esc(wordAfter)}%'))`;
  leadQuery    = `Email LIKE '%${esc(emailDomain)}%' AND (Email LIKE '%${esc(firstName)}%' OR Email LIKE '%${esc(lastName)}%') AND (Company = '${esc(companyName)}' OR (Company LIKE '%${esc(wordBefore)}%' AND Company LIKE '%${esc(longestWord)}%' AND Company LIKE '%${esc(wordAfter)}%')) AND IsConverted = False`;
}

return { contactQuery, leadQuery };
```

> **Dead-code SOQL note:** the generated `leadQuery` and `contactQuery` outputs are referenced by the Find Lead and Find Contact steps in the spec, but **the actual SF Find nodes use their own hardcoded WHERE clauses, NOT the generated queries**. The Code node's output is unused in the current Zap. Fix during migration: either delete the Code node and use the simple hardcoded WHEREs in the Find nodes, OR wire the generated queries into the Find nodes. We choose the latter — it's the more robust dedup approach. See failure mode #2 in §12.

### 6.4 `Assignment Owner` (316797562) — region routing

```js
const inputRegion = inputData.inputRegion;
let InsideSalesQueue, BusinessHours, AssignmentID, NotificationEmail, LeadAccountId;

switch (inputRegion) {
  case 'Australia':
  case 'Australia & New Zealand':
  case 'Asia':
    InsideSalesQueue = '00G0L000004WbECUA0';
    BusinessHours    = '01m0L00000001OZQAY';
    AssignmentID     = '0050L000008hH5DQAU'; // Josh O'Connell
    LeadAccountId    = '001Ki000009wWMPIA2'; // R360 Lead Account - APAC
    NotificationEmail = 'josh.oconnell@pointofrental.com, kayla.oloughlin@pointofrental.com, conor.cummins@pointofrental.com, katie.mcfarland@pointofrental.com, dhaber@record360.com, jenna@record360.com';
    break;
  case 'Africa':
    InsideSalesQueue = '00G4u000004AmQJEA0';
    BusinessHours    = '01m0L00000001PcQAI';
    AssignmentID     = '0054u0000094ck7AAA'; // Katie (R360 — Bernice Smith dead-code commented out)
    LeadAccountId    = '0014u00002BFXvRAAX'; // R360 Lead Account - North America
    NotificationEmail = 'bernice.smith@pointofrental.com, katie.mcfarland@pointofrental.com, jenna@record360.com, dhaber@record360.com';
    break;
  case 'Europe':
    InsideSalesQueue = '00G0L000004WbEDUA0';
    BusinessHours    = '01m0L00000001PcQAI';
    AssignmentID     = '0050L000008uAHvQAM'; // Dean Hammond
    LeadAccountId    = '001Ki000009wWM0IAM'; // R360 Lead Account - Europe
    NotificationEmail = 'dean.hammond@pointofrental.com, katie.mcfarland@pointofrental.com, john.ryder@record360.com, dhaber@record360.com, jenna@record360.com';
    break;
  case 'North America':
    InsideSalesQueue = '00G0L000004WbEEUA0';
    BusinessHours    = '01m0h0000005HbeAAE';
    AssignmentID     = '0054u0000094ck7AAA'; // Katie (R360)
    LeadAccountId    = '0014u00002BFXvRAAX'; // R360 Lead Account - North America
    NotificationEmail = 'katie.mcfarland@pointofrental.com, dhaber@record360.com, jenna@record360.com, may@record360.com';
    break;
  case 'South America':
    InsideSalesQueue = '00G0L000004WbEEUA0';
    BusinessHours    = '01m0L00000001PcQAI';
    AssignmentID     = '0054u0000094ck7AAA';
    LeadAccountId    = '0014u00002BFXvRAAX';
    NotificationEmail = 'katie.mcfarland@pointofrental.com, dhaber@record360.com, jenna@record360.com';
    break;
  default:
    InsideSalesQueue = '00G0L000004WbEEUA0';
    BusinessHours    = '01m0h0000005HbeAAE';
    AssignmentID     = '0054u0000094ck7AAA';
    LeadAccountId    = '0014u00002BFXvRAAX';
    NotificationEmail = 'katie.mcfarland@pointofrental.com, dhaber@record360.com, jenna@record360.com';
    break;
}

return { InsideSalesQueue, BusinessHours, AssignmentID, NotificationEmail, LeadAccountId };
```

> **Refactor candidate (Phase 2, not Phase 1):** lift this hardcoded switch into a SF custom metadata table `R360_Region_Routing__mdt` with rows per region. n8n queries the table once on startup and caches in `staticData`. Phase 1: port verbatim.

---

## 7. Salesforce Field Maps (verbatim from Zap, with corrections)

> **Verified against Zapier export 2026-05-17** — field maps in §7.3–§7.4 were audited against Zap 316797554 node-by-node. See full audit findings in `/tmp/zap-316797554-fieldmap-verification.md`. DRIFT-1 and DRIFT-2 were critical errors (node IDs transposed, Case creation on wrong path) corrected in this revision.

> Two universal n8n adjustments apply to every SF Update node below:
> 1. **Empty-key filter Set node** before each SF Update — drops keys where `value === "" || value == null`. Without this, n8n overwrites SF values with empty string. (See §2.3 + UAT C-9.)
> 2. **Path-specific corrections** are called out inline.

### 7.1 Path A4b — Create Lead (no Lead, no Contact, NOT ContactForm)

SF object: `Lead`. Source: Zap node 316797589.

```
record_id:                  (none — create)
useAssignmentRules:         false
LastName:                   {{formattedLast}}
FirstName:                  {{formattedFirst}}
Company:                    {{formattedCompany}}
RecordTypeId:               012Ki000000bpgRIAQ          // R360 Lead RT
Country:                    {{formattedCountry}}
MobilePhone:                {{phone}}
Phone:                      {{phone}}
Email:                      {{formattedEmail}}
LeadSource:                 {{utmsource}}                // mapped: AdWords / Marketing: Organic / Email marketing
HasOptedOutOfEmail:         false
IsConverted:                false
DoNotCall:                  false
HasOptedOutOfFax:           false
Sales_Notes__c:             "First Name: {{formattedFirst}}\nLast Name: {{formattedLast}}\nCompany Name: {{formattedCompany}}\nEmail: {{formattedEmail}}\nPhone Number: {{phone}}\nIndustry: {{formattedIndustry}}\nRegion: {{formattedRegion}}\nROI Calculator: {{roiCalculator}}"
Discovery_Notes__c:         (same template as Sales_Notes__c)
OwnerId2:                   {{AssignmentID}}             // ← from Assignment Owner code
Most_Recent_Pardot_Form__c: "R360 - " + WPFormName       // ← BUG-FIXED (was hardcoded "R360 - Contact Form")
MQL__c:                     true
pi__utm_campaign__c:        {{utmCampaign}}
pi__utm_content__c:         {{utmContent}}
pi__utm_medium__c:          {{utmMedium}}
pi__utm_source__c:          {{utmSource}}
pi__utm_term__c:            {{utmTerm}}
utm_campaign__c:            {{utmCampaign}}
utm_medium__c:              {{utmMedium}}
utm_source__c:              {{utmSource}}
utm_term__c:                {{utmTerm}}
Lead_Override_Date__c:      <today>
Raw_Marketing_Lead__c:      true
R360_Record__c:             true
fbc__c:                     {{fbc}}
fbp__c:                     {{fbp}}
gclid__c:                   {{gclid}}
msclkid__c:                 {{msclkid}}
Description:                {{note || ""}}              // ← NEW: pipe message body / bot transcript here (failure mode #3 fix)
```

After Create: `add_lead_to_campaign` (Zap 334669861) → CampaignMember update (§7.5).

### 7.2 Path B / Path A4a — Update Lead

SF object: `Lead`. Source: Zap nodes 316797571 (Path B) and 316797638 (Path A4a). Differences from Path A4b:

```
record_id:                  {{leadId}}                   // ← from Find Lead
useAssignmentRules:         false
LastName:                   ""                            // ← empty-key filter strips this
FirstName:                  ""                            // ← strips
Company:                    ""                            // ← strips
Country:                    {{formattedCountry}}
Phone:                      ""                            // ← strips (don't overwrite phone)
MobilePhone:                {{phone}}
Email:                      {{formattedEmail}}
R360_Record__c:             true
MQL__c:                     true
gaconnector_Country__c:     {{formattedCountry}}
Account__c:                 {{LeadAccountId}}             // ← from Assignment Owner
Lead_Override_Date__c:      <today>
Most_Recent_Pardot_Form__c: "R360 - " + WPFormName       // ← BUG-FIXED
OwnerId2:                   {{AssignmentID}}
pi__utm_*__c, utm_*__c:     <UTM>
Sales_Notes__c:             "Form Filled: {{WPFormName}}\n..."   // prefixes with form name
pi__notes__c:               (same)
Discovery_Notes__c:         (same)
Description:                {{note || ""}}              // ← NEW: pipe message body
LeadSource:                 {{utmsource}}
Raw_Marketing_Lead__c:      true
Industry:                   {{formattedIndustry}}
fbp__c, fbc__c, gclid__c, msclkid__c: <tracking>
RecordTypeId:               012Ki000000bpgRIAQ
```

After Update: `add_lead_to_campaign` + update CampaignMember.

### 7.3 Path C — Update Contact, AM (Contact + Account.Status="Customer")

SF object: `Contact`. Source: Zap node **316797656** (filter: 316797655 "AM: Yes Contact + Yes Customer"). Routes to Account Manager. **Followed by Case creation (node 316797659) — see §7.6.**

> DRIFT-1 corrected: node is 316797656, not 316797669. DRIFT-2 corrected: Case IS created on this path.

**Fields set by node 316797656 (verified against Zap export):**

```
record_id:                  {{contactId}}
LastName:                   {{formattedLast}}
FirstName:                  {{formattedFirst}}
Phone:                      {{phone}}
MobilePhone:                {{phone}}
OwnerId:                    {{AssignmentID}}              // Account Manager assignment
Status__c:                  "Cold / Not Started"
Most_Recent_Pardot_Form__c: ""                           // Intentionally empty in Zap (NOT set to form name)
Date_Of_Most_Recent_Pardot_Form__c: ""                  // Intentionally empty
Queue_Region__c:            ""                           // Intentionally empty
Campaign__c:                ""                           // Intentionally empty
Assigned_SDR__c:            ""                           // Intentionally empty
Sales_Notes__c:             "First Name: {{formattedFirst}}\n..."  // No "Form Filled:" prefix on initial query path
Inside_Lead_Sales_Notes__c: (same template as Sales_Notes__c)
pi__notes__c:               (same template as Sales_Notes__c)
Notes__c:                   (same template as Sales_Notes__c)
Email:                      {{formattedEmail}}
pi__utm_source__c:          {{316797554__utmSource}}     // RAW WEBHOOK (Zap inconsistency — see DRIFT-7)
pi__utm_medium__c:          {{utmMedium}}
pi__utm_content__c:         {{utmContent}}
pi__utm_campaign__c:        {{utmCampaign}}
pi__utm_term__c:            {{utmTerm}}
LeadSource:                 {{utmsource}}
CRO1__c:                    {{CRO1}}
CRO2__c:                    {{CRO2}}
pi__url__c:                 ""                           // Empty in Zap — ← BUG-FIX: populate with {{cleanedLanding}} in n8n (DRIFT-5: field exists but empty)
HasOptedOutOfEmail:         false
R360_Record__c:             true
UTM_Source_Most_Recent__c:  {{316797554__utmSource}}    // RAW WEBHOOK (same Zap inconsistency)
UTM_Term_Most_Recent__c:    {{utmTerm}}
UTM_Medium_Most_Recent__c:  {{utmMedium}}
UTM_Campaign_Most_Recent__c:{{utmCampaign}}
UTM_Term__c:                {{utmTerm}}                  // ← BUG-FIXED (was raw {{field27}} in Zap)
utm_term__c:                {{utmTerm}}
Lead_Override_Date__c:      <today>
Raw_Marketing_Lead__c:      true
fbp__c, fbc__c, gclid__c, msclkid__c: <tracking>
```

**Fields NOT set on Path C (confirmed absent from node 316797656):**
- `MQL__c` — absent on AM path (present on SDR path D)
- `Lead_Owner__c` — absent on AM path (present on SDR path D)
- `dupcheck__dc3DisableDuplicateCheck__c` — absent on AM path
- `Description` — absent on AM path (present on SDR path D with raw field7 bug)
- `SAL__c`, `Demo_Scheduled__c`, `Interest_Level__c`, `Meeting_Type_CP__c` — all absent

**n8n build corrections for Path C:**
- `pi__url__c`: change `""` → `{{cleanedLanding}}` (failure mode #5 fix)
- `UTM_Term__c`: keep `{{utmTerm}}` (already corrected from raw `field27`)
- `utm_source__c` / `pi__utm_source__c`: use `{{utmSource}}` from formatter output (DRIFT-7 fix — Zap uses raw webhook, n8n should use normalized value)
- `Most_Recent_Pardot_Form__c`: the Zap sets this to `""` (empty). No hardcoded bug here. Leave as empty OR populate with `"R360 - " + WPFormName` if desired (net-new improvement, not a bug fix for this path).
- `Description`: absent in Zap. If adding (for bot transcript pipe, failure mode #11), this is NET-NEW for the AM path.

After Update: Create Case (node 316797659, §7.6) → `add_contact_to_campaign` (node 316797660, sets `Sales_Case_Associated__c`) → update CampaignMember.

### 7.4 Path D — Update Contact, SDR (Contact, not Customer)

SF object: `Contact`. Source: Zap node **316797669** (filter: 316797668 "SDR: Yes Contact, No Customer"). Routes to SDR queue. **No Case creation on this path.**

> DRIFT-1 corrected: node is 316797669, not 316797656. DRIFT-2 corrected: Case is NOT created on this path.

**Fields set by node 316797669 (verified against Zap export):**

```
record_id:                  {{contactId}}
LastName:                   {{formattedLast}}
FirstName:                  {{formattedFirst}}
MQL__c:                     true                         // SDR path sets MQL (absent on AM path)
Phone:                      {{phone}}
MobilePhone:                {{phone}}
OwnerId:                    {{AssignmentID}}
Status__c:                  "Cold / Not Started"
Most_Recent_Pardot_Form__c: "R360 - Contact Form"        // Hardcoded in Zap — ← BUG-FIX: change to "R360 - " + WPFormName (DRIFT-4)
Date_Of_Most_Recent_Pardot_Form__c: ""
Queue_Region__c:            ""
Campaign__c:                ""
Assigned_SDR__c:            ""
Sales_Notes__c:             "First Name: {{formattedFirst}}\n..."  // No "Form Filled:" prefix
Inside_Lead_Sales_Notes__c: (same template as Sales_Notes__c)
pi__notes__c:               "First Name: ...\nPhone Number: {{phone}}\n..."  // Uses formatted phone
Notes__c:                   (same template as Sales_Notes__c)
Email:                      {{formattedEmail}}
pi__utm_campaign__c:        {{utmCampaign}}
pi__utm_source__c:          {{316797554__utmSource}}    // RAW WEBHOOK — ← BUG-FIX: use {{utmSource}} (DRIFT-7)
pi__utm_medium__c:          {{utmMedium}}
pi__utm_content__c:         {{utmContent}}
pi__utm_term__c:            {{utmTerm}}
Lead_Owner__c:              {{AssignmentID}}             // SDR-specific (absent on AM path)
dupcheck__dc3DisableDuplicateCheck__c: true              // SDR-specific: bypass DupCheck
Description:                "First Name: ...\nPhone Number: {{316797554__field7}}\nRegion: ..."
                            // ← BUG-FIX: replace {{field7}} with {{formattedPhone}} (DRIFT-3: field exists but has raw phone bug)
LeadSource:                 {{utmsource}}
CRO1__c:                    {{CRO1}}
CRO2__c:                    {{CRO2}}
pi__url__c:                 ""                           // Empty in Zap — ← BUG-FIX: populate with {{cleanedLanding}}
HasOptedOutOfEmail:         false
R360_Record__c:             true
UTM_Source_Most_Recent__c:  {{316797554__utmSource}}    // RAW WEBHOOK — ← BUG-FIX: use {{utmSource}}
UTM_Term_Most_Recent__c:    {{utmTerm}}
UTM_Medium_Most_Recent__c:  {{utmMedium}}
UTM_Campaign_Most_Recent__c:{{utmCampaign}}
UTM_Term__c:                {{316797554__field27}}       // RAW WEBHOOK — ← BUG-FIX: use {{utmTerm}}
utm_term__c:                {{utmTerm}}
pi__utm_term__c:            {{utmTerm}}
Lead_Override_Date__c:      <today>
Raw_Marketing_Lead__c:      true
fbp__c, fbc__c, gclid__c, msclkid__c: <tracking>
```

**Fields NOT set on Path D (confirmed absent from node 316797669):**
- `SAL__c`, `MQD__c`, `SAD__c`, `Contact_Request__c` — all absent
- `Marketing_Status__c`, `Demo_Completed__c`, `Assigned_SDR__c` (write), `Most_Recent_Pardot_Form__c='AI BOT'` — absent

**n8n build corrections for Path D:**
- `Description`: change `{{field7}}` → `{{formattedPhone}}` (DRIFT-3 fix — field exists in Zap but has raw phone bug)
- `Most_Recent_Pardot_Form__c`: change hardcoded `"R360 - Contact Form"` → `"R360 - " + WPFormName` (DRIFT-4 fix — same hardcoded bug applies here)
- `UTM_Term__c`: change `{{field27}}` → `{{utmTerm}}`
- `utm_source__c` / `pi__utm_source__c`: use `{{utmSource}}` from formatter (DRIFT-7 fix)
- `pi__url__c`: change `""` → `{{cleanedLanding}}`
- **No Case node** after this Contact update. Path D subtree: update_contact → Gmail → add_contact_to_campaign (node 316797673).

After Update: Gmail notification → `add_contact_to_campaign` (node 316797673, sets `Status='Cold / Not Started'`) → update CampaignMember. **No Case creation.**

### 7.5 Path A4c-i — Update Contact (ReQuery, NOT customer) — fbp `/f` prefix bug

SF object: `Contact`. Source: Zap node 316797607. **CRITICAL BUG FIX:** the original spec hardcodes `string::fbp__c: "/f{{316797554__fbp}}"` — the `/f` prefix corrupts the value for Contacts on this path. Fix: drop the `/f` prefix.

Otherwise field map is similar to Path C (AM path, node 316797656) — this is the NOT-customer requery branch, which creates a Case. Also has the Description raw `field7` bug (same as Path D, node 316797669) — fix: replace `{{field7}}` with `{{formattedPhone}}`. Followed by Create Case (node 316797628, same field map as 316797659).

### 7.6 Case create field map (used by Path C and Path A4c-i/A4c-ii)

> DRIFT-2 corrected: Case is on Path C (AM/Customer), NOT Path D (SDR/Prospect).

Source: Zap node 316797659 (Path C — AM initial query) and 316797628 (Path A4c-ii — AM requery). Path A4c-i also creates a Case (uses same field map, different ContactId source). Path D does NOT create a Case.

OwnerId is a single hardcoded queue `00GKi0000016PF2MAM` for both Path C and A4c-i/A4c-ii — all Customer Cases go to the same queue regardless of path.

```
RecordTypeId:    0124u000000l5qwAAA          // Inside Sales Case RT
OwnerId:         00GKi0000016PF2MAM          // Hardcoded queue (Path C verified — same queue for all Customer Cases)
OwnerId2:        ""                          // Intentionally empty
ContactId:       {{contactId}}               // {{318022712__id}} on initial query; {{316797567__id}} on requery paths
AccountId:       (NOT PRESENT in Zap — absent from node 316797659)
Subject:         "R360 - Contact Form"       // Hardcoded in Zap (not dynamic WPFormName)
SuppliedName:    {{formattedFirst}} {{formattedLast}}
SuppliedEmail:   {{formattedEmail}}
SuppliedPhone:   {{phone}}
SuppliedCompany: {{formattedCompany}}
Description:     "First Name: ...\nRegion: ..."  // Long-form note (does NOT use raw field7 here)
Origin:          "Web"
Status:          "New"
Priority:        "Medium"
Type:            "R360 Sales"
Campaign__c:     701Ki000000cMwkIAE          // Hardcoded R360 Website Campaign
UTM_Campaign__c: {{316797554__field22}}      // RAW WEBHOOK — ← n8n: use {{utmCampaign}}
UTM_Medium__c:   {{316797554__field21}}      // RAW WEBHOOK — ← n8n: use {{utmMedium}}
UTM_Source__c:   {{316797554__field20}}      // RAW WEBHOOK — ← n8n: use {{utmSource}}
BusinessHoursId: 01mE0000000HjdIIAS          // Hardcoded
allowDuplicates: false
```

> Note: `AccountId` is absent from the Zap's Case create (node 316797659). Build plan previously implied it was set. Do NOT add AccountId unless confirmed with SF Admin — Case may look up Account via ContactId automatically.

After Create Case: `add_contact_to_campaign` (node 316797660) sets `Sales_Case_Associated__c: {{316797659__id}}` to link the CampaignMember to this Case.

### 7.7 Email Notification Templates (Gmail SMTP)

5 distinct email subjects, one body template:

| Subject | Path |
|---|---|
| `R360 Lead Created` | A4b (new Lead) |
| `R360 Lead Updated` | B (existing Lead update) |
| `Contact Form Page - R360 Contact Updated` | A4c-i (requery contact) and D (SDR contact update) |
| `R360 Lead Converted to Contact` | A4a (Lead found via requery, converted to Contact) |
| `R360 Contact AM Notice` | C (Customer routing, AM notification) |

Body template (verbatim from spec, applies to all 5):
```
{{WPFormName}} Form Fill — {{formattedFirst}} {{formattedLast}} ({{formattedCompany}})

Email:    {{formattedEmail}}
Phone:    {{phone}}
Region:   {{formattedRegion}}
Industry: {{formattedIndustry}}
ROI Calculator: {{roiCalculator}}

SF Record:    {{sf_record_url}}
Form Filled:  {{WPFormName}} on {{today}}
Routed to:    {{AssignmentID_user_name}} ({{NotificationEmail.first}})
```

Recipients: the `NotificationEmail` string from the Assignment Owner Code node (region-specific, comma-separated).

> **DRIFT-8 (net-new feature note):** The source Zap 316797554 has **no per-path Slack DM notifications**. All 8 Slack nodes in the Zap are error handlers posting to channel `C06TTMZB3RA` ("Lead Create Fail" bot) only on failure branches. Success-path regional notifications go exclusively via Gmail SMTP to the `NotificationEmail` list above. The per-path Slack DM to `User.Slack_ID__c` (step 16 in §5.2 table) is **NET-NEW behavior** being added in the n8n migration — it does not exist in the Zap and must be built from scratch, including the `User.Slack_ID__c` SOQL lookup. UAT test cases C-5, C-6, C-19 cover this new behavior.

### 7.8 Convert Lead via HTTP node — `sub-convert-lead.json`

Replaces n8n SF node (no native `convertLead` support).

```http
POST https://{{instance}}.my.salesforce.com/services/data/v62.0/sobjects/LeadConvert/
Authorization: Bearer {{$credentials.salesforce.accessToken}}
Content-Type: application/json

{
  "leadId": "{{ $json.leadId }}",
  "convertedStatus": "Qualified",
  "doNotCreateOpportunity": false,
  "accountId": "{{ $json.regionLeadAccountId }}"   ← bug fix: region-aware (was hardcoded NA only)
}
```

Returns: `{ "leadId", "contactId", "accountId", "opportunityId" }`. Pipe `contactId` into the success handler that adds the new Contact to the campaign.

---

## 8. R360 Pre-Discovery (Zap 336544812) — Deep Spec

**Source of truth:** `migration-plans/specs/spec_pre_discovery_ai_notes.md` (R360 columns).
**Scope:** Zap 336544812 only — POR Pre-Discovery (336534697) is OUT of scope for this migration.
**Topology:** webhook → SF lookups (3 calls) → Perplexity `sonar-deep-research` → Apollo enrichment → ChatGPT `gpt-5.1` → Slack DM (3 recipients) → Markdown→HTML → SF Contact write (2 fields).

### 8.1 Trigger contract — webhook POST shape

The caller (a Salesforce Flow on Opportunity stage change, an Outreach/Salesloft pre-meeting trigger, or a Calendly hook) POSTs JSON with exactly three required fields. No authentication on the webhook node itself; rely on the URL being secret and rate-limited at the n8n proxy layer.

```json
{
  "accountId":  "0014u00002ABCdEAAA",   // 18-char SF Account Id (required)
  "contactId":  "0034u00002XYZ12AAA",   // 18-char SF Contact Id (required)
  "ownerEmail": "ae.name@pointofrental.com"  // SF User.Email of the AE who owns the deal (required)
}
```

**Halt-on-missing logic (FIRST n8n node after the receiver):**

```js
const required = ['accountId', 'contactId', 'ownerEmail'];
for (const k of required) {
  const v = $json[k];
  if (!v || typeof v !== 'string' || v.trim() === '') {
    throw new Error(`Pre-Discovery rejected: missing required field "${k}"`);
  }
}
return $input.all();
```

This mirrors Zapier's `_zap_search_success_on_miss: "False"` halt behavior. The error feeds the standard `sub-error-handler` which logs to `Lead_Inbound_Log__c` (Source = `webhook_pre_discovery`, Status = `failed`).

### 8.2 SF lookup chain — 3 sequential calls

Order is fixed (matches Zap node order so AE Slack ID is available before Perplexity returns).

| # | Operation | Object | Search field | Search value | On miss | Fields needed downstream |
|---|---|---|---|---|---|---|
| 1 | Find Account | `Account` | `Id` | `{{ $json.accountId }}` | Halt | `Name`, `Website`, `ShippingCountry` (NOT `Division__c` — R360 has no AMER/EMEA branching) |
| 2 | Find Contact | `Contact` | `Id` | `{{ $json.contactId }}` | Halt | `Id`, `Name`, `FirstName`, `LastName`, `Email`, `Phone`, `MobilePhone`, `Title` |
| 3 | Find AE/Owner | `User` | `Email` | `{{ $json.ownerEmail }}` | Halt | `Slack_ID__c` (CRITICAL — drives Slack DM recipient) |

**Critical note on `User.Slack_ID__c`:** This is a custom field on the SF User object (format `U0XXXXXXX`). If the AE's record has no `Slack_ID__c`, fall back to email notification only (do NOT halt — the brief still needs to land in SF). See §8.10 error paths.

### 8.3 Perplexity `sonar-deep-research` config

**Endpoint:** `POST https://api.perplexity.ai/chat/completions` via n8n HTTP Request node.

| Param | Value |
|---|---|
| Model | `sonar-deep-research` (62× heavier than POR's `sonar-pro`) |
| Max tokens | `128000` |
| System message | `"Be precise and concise."` |
| Latency expectation | **60–120 seconds** — confirmed in spec, requires async pattern (see §8.4) |
| Auth | Bearer token from Perplexity credential (re-issued in n8n) |

**User prompt template (verbatim — populate `{{...}}` from earlier nodes):**

```
You are a Record360 Sales Research Brief generator. Produce a structured 14-section research brief for the company below.

Company: {{ $('Find Account').item.json.Name }}
Website: {{ $('Find Account').item.json.Website }}
Country: {{ $('Find Account').item.json.ShippingCountry }}

Contact: {{ $('Find Contact').item.json.Name }}
Title:   {{ $('Find Contact').item.json.Title }}
Email:   {{ $('Find Contact').item.json.Email }}
Phone:   {{ $('Find Contact').item.json.Phone }}
Mobile:  {{ $('Find Contact').item.json.MobilePhone }}

Sections (use these headings verbatim):
1. Basic Profile — HQ, founded, ownership, public/private
2. Scale — employees, revenue range, branch count
3. Fleet Composition & Risk — equipment categories, age, primary use
4. Damage / Insurance / Policies — known incident history, insurer, claims posture
5. Tech Stack — focus on rental ERP/DMS only. Recognize: Wynne, Texada, Point of Rental, Alert, Infor, CDK, Karmak, Fleetio. Do NOT enumerate generic SaaS or party/event ERPs.
6. Resale & Lifecycle — used-equipment program, auction partners
7. Person Intel — LinkedIn URL, prior roles, mutual connections (if surfaceable)
8. Awards & Recognition — company awards, individual awards
9. High-Value Talking Points — 3 hooks Record360 can use (damage protection, inspection workflows, asset compliance)
10. Strategic Initiatives — recent press releases, hiring patterns, geographic expansion
11. Buying Committee — likely Record360 stakeholders: Operations, Risk Management, Compliance, COO/CFO
12. Digital Maturity — website signals, customer portal sophistication
13. Customer Base — end customer segments served (construction, logistics, etc.)
14. Online Sentiment — review aggregate (G2, Capterra, Reddit r/Construction)
15. Source List — explicit URLs cited in the research

Write each section in markdown. Cite sources inline as [Source: <URL>]. Do not invent facts.
```

### 8.4 Async pattern — return 200, queue the long chain

**Why required:** Perplexity alone can hit 120 seconds; ChatGPT with `reasoning: high` and `web_search_preview` adds 30-60 seconds; total can exceed n8n's default webhook 30s response window. SocialIntents, Salesforce, and most upstream callers retry on >30s timeout — without async, you get duplicate research runs.

**Pattern (n8n queue mode required — Redis + Postgres):**

```
[Webhook node] (responseMode: "lastNode")
  └─→ [Set: Validate payload] (halt-on-missing per §8.1)
  └─→ [Respond to Webhook: 200 OK] ← SocialIntents/SF caller satisfied here
  └─→ [Execute Workflow: pre-discovery-async-chain] (the long chain runs on n8n worker pool)
```

The `pre-discovery-async-chain` sub-workflow runs the 9-step API chain (§8.5–§8.9). Workflow timeout: 600s (10 min). On failure, fall through to the `sub-error-handler` which logs to `Lead_Inbound_Log__c` and Slack-pages.

**Required infrastructure:** n8n must be running in queue mode. Default "main" execution mode blocks the webhook response until the workflow completes — that breaks this pattern. See `runbooks/pre-cutover-validation.md` §1 for queue mode credential procurement.

### 8.5 Apollo contact enrichment

> **Status (2026-05-10): DEFERRED from v1.** Per user decision, Pre-Discovery v1 ships without Apollo enrichment. The brief still works with Perplexity-only research. The Apollo node and write-back to `MobilePhone` are kept in the spec for the v2 add-back. To skip in v1: comment out / disable the `HTTP: Apollo enrich` and `SF Update Contact: MobilePhone (post-Apollo)` nodes in `webhook-pre-discovery-r360.json`.

**Endpoint:** `POST https://api.apollo.io/api/v1/people/match` via n8n HTTP Request node.

| Input field | Source |
|---|---|
| `email` | `{{ $('Find Contact').item.json.Email }}` |
| `first_name` | `{{ $('Find Contact').item.json.FirstName }}` |
| `last_name` | `{{ $('Find Contact').item.json.LastName }}` |
| `phone` | `{{ $('Find Contact').item.json.Phone }}` |
| `organization_name` | `{{ $('Find Account').item.json.Name }}` |
| `min_confidence` | `70` (only return matches with 70%+ score) |

**Write-back to SF (post-Apollo, before ChatGPT):**

```
[SF Update Contact]
  Record Id: {{ $('Find Contact').item.json.Id }}
  Fields:
    MobilePhone: {{ $('Apollo enrich').item.json.person.mobile_phone || '' }}
```

If Apollo returns 0 matches (`person == null`), do NOT halt — continue to ChatGPT with Apollo data omitted. The brief gracefully handles missing enrichment. The empty-key-filter Set node from §2.3 ensures we don't blank out an existing `MobilePhone` value.

**Note on Apollo response shape:** Spec lists `data[]attributes.mobilePhone` (Zapier's array-flattening notation). The actual Apollo People Match API v1 response shape is `data.person.mobile_phone` or `data.person.phone_numbers[]` (filter to `type=mobile`). Validate against a live Apollo response before binding the field — see C-18 below.

### 8.6 ChatGPT `gpt-5.1` config — R360 brief

**Endpoint:** `POST https://api.openai.com/v1/responses` (Responses API, NOT Chat Completions) via n8n HTTP Request node.

| Param | Value |
|---|---|
| Model | `gpt-5.1` |
| Max output tokens | `400000` |
| Reasoning effort | `high` |
| Response format | `text` |
| Tools | `[{"type": "web_search_preview"}]` (R360 has live web search; POR does not) |
| Temperature | unset (default) |
| Instructions (system) | `""` (empty — all instructions in user message) |
| Auth | OpenAI credential (re-issued in n8n) |

**User message template (verbatim from spec, ~9 sections):**

```
SYSTEM CONTEXT: AI SALES ENABLEMENT ASSISTANT (Record360)

You are an AI sales research and enablement assistant for Record360, a damage-protection and asset-inspection platform sold into equipment rental, fleet, and logistics companies.

## INPUTS
From Perplexity → {{ JSON.stringify($('Perplexity').item.json) }}
From Apollo (ZoomInfo) → {{ JSON.stringify($('Apollo enrich').item.json) }}

## DATA HANDLING RULES
1.1  Use ALL intel from Perplexity and Apollo. Do not discard signal.
1.2  When intel is thin, use the web_search_preview tool to enrich (max 5 calls).
1.3  Fact discipline: if a claim isn't sourced in Perplexity output, in Apollo output, or in your web search, do NOT include it.
1.4  Bias toward deal-closing intel: damage incidents, insurance posture, asset disputes, audit findings.

## SLACK FORMATTING RULES
- Use Slack link syntax: <URL|Label>. Do NOT use Markdown [Label](URL).
- Bold: *single asterisks* (Slack mrkdwn). Do NOT use **double asterisks**.
- Use emoji on every section header.
- Telegraphic style — no fluff sentences.

## SECTION LOGIC (3.1–3.9)
3.1  Always include PROSPECT.
3.2  Always include FLEET SNAPSHOT.
3.3  KEY INTEL: 2–6 bullets, only if confidently sourced.
3.4  AWARDS: include only if Perplexity surfaced ≥1 award.
3.5  ERP DETECTED: include only if tech stack section identified Wynne / Texada / POR / Alert / Infor / CDK / Karmak / Fleetio. Otherwise omit.
3.6  DISCOVERY MENU: pick up to 3 angles from R360's 5-category menu (below).
3.7  NAME DROPS: only verified industry peers (no placeholders).
3.8  PROOF: Slack-formatted case study link, mapped by industry — Construction → r360.com/case/skanska, Logistics → r360.com/case/penske, etc.
3.9  Omit any section that has no content rather than emitting "TBD" or "N/A".

## R360 DISCOVERY CATEGORIES (5)
- Damage Disputes ("The Blame Game")    — driver/customer/lot disputes; lost recoveries
- Process Compliance ("Pencil Whipping") — inspection paperwork integrity; audit findings
- Recovery & Billing                     — speed of damage→invoice conversion; write-offs
- Asset Lifecycle (Resale Value)         — depreciation accuracy; auction price impact
- Liability & Safety                     — driver behavior, accident reconstruction

## OUTPUT TEMPLATE (Slack mrkdwn)
🚨 R360 PRE-CALL BRIEF: [Account Name]

👤 *PROSPECT:* [Name]
   • Role: [Title] · Function: [Function inferred]
   • Location: [City, Country]
   • LinkedIn: <[URL]|profile>
   • Background: [1 sentence]

🏢 *FLEET SNAPSHOT*
   • Scale: [employees / revenue / branches]
   • Fleet: [composition]
   • Risk Profile: [age, mix, exposure]
   • Positioning: [growth/stable/distressed]

🔎 *KEY INTEL*
   • [bullet 1]
   • [bullet 2]
   • [bullet 3]

🏅 *AWARDS & RECOGNITION* (only if surfaced)
   • Company: [list]
   • Individual: [list]

💻 *ERP DETECTED:* [name]
   → Ask: "We've seen damage photos / dispute logs in [ERP] — can we look at one together?"

🧠 *DISCOVERY MENU (Top Angles)*
[For each of up to 3 categories:]
   ▸ [Category Name] ([slogan])
     Signal: [evidence from intel]
     Ask: "[exact words to use]"

🗣️ *NAME DROPS:* [verified peer 1], [verified peer 2]

📚 *PROOF:* <[case study URL]|[Customer Name] — [outcome metric]>

Return the brief in Slack mrkdwn. NO MARKDOWN HEADERS. NO CODE FENCES.
```

**Output extraction:** Use `output_text` (final complete text) for SF write path; use `messages[]content[]text` for Slack DM path. Both come from the same Responses API response.

### 8.7 Slack DM — 3 recipients, Block Kit format

**Endpoint:** `POST https://slack.com/api/chat.postMessage` via n8n HTTP Request node OR n8n Slack node (community).

**Recipients (always):**
- `U02HR1T6PBK` (RevOps system owner)
- `U01B0955NEQ` (RevOps manager)
- `{{ $('Find AE/Owner').item.json.Slack_ID__c }}` (the AE who owns the deal)

The DM is sent **once per recipient** (loop the HTTP node OR use Slack's `chat.postMessage` with a single user_id at a time — Slack API does not support multi-recipient DMs in one call).

**Payload per DM:**

```json
{
  "channel": "<recipient_user_id>",
  "text": "{{ $('OpenAI gpt-5.1').item.json.output_text }}",
  "as_user": false,
  "username": "RevOps AI Intel",
  "icon_url": "https://i.ibb.co/m5KMWdgH/Rev-Ops-Logo.png",
  "unfurl_links": false,
  "unfurl_media": false,
  "link_names": true
}
```

**Critical:** `unfurl_links: false` and `unfurl_media: false` — Slack will otherwise expand every URL in the brief into a link preview, blowing up the message size and rate-limiting the bot. POR Pre-Discovery uses `unfurl: true`; R360 deliberately disables it.

**Auth:** R360 Slack bot token (different from POR bot — Zapier auth ID 51104497). Re-issue in n8n.

### 8.8 Markdown → HTML conversion

ChatGPT returns Slack mrkdwn. SF rich-text fields render HTML. Convert before write.

**n8n Code node:**

```js
const { marked } = require('marked');
const md = $('OpenAI gpt-5.1').item.json.output_text;

// marked converts standard Markdown but we use Slack mrkdwn — pre-process:
const cleaned = md
  .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '[$2]($1)')   // Slack <url|label> → MD [label](url)
  .replace(/\*([^\*\n]+)\*/g, '**$1**');                     // Slack *bold* → MD **bold**

return [{ json: { html: marked.parse(cleaned) } }];
```

Verify the `marked` package is in n8n's `package.json`. If not, install via the n8n custom-node mechanism or use a built-in `Markdown to HTML` community node.

### 8.9 SF Contact updates — 2 writes (rich-text + timestamp)

The R360 path writes **two fields** on the same Contact record. The Apollo write (§8.5) is a third earlier write. All three target the same Contact via `{{ $('Find Contact').item.json.Id }}`.

**Final write (after Markdown→HTML):**

```
[SF Update Contact]
  Record Id: {{ $('Find Contact').item.json.Id }}
  Fields:
    Record360_AI_Contact_Brief__c:    {{ $('MD→HTML').item.json.html }}    // rich-text HTML
    R360_Last_AI_Contact_Brief__c:    {{ $now.toISO() }}                    // FIX: Zapier left this blank; n8n stamps it
```

**The blank-date bug:** Zapier's config has `"R360_Last_AI_Contact_Brief__c": ""` (empty string). The field exists in SF and was intended to track "when did the AI brief last refresh?" but was never being populated. n8n MUST stamp this field at execution time so SF finally has a usable timestamp.

**Field types in SF:**
- `Record360_AI_Contact_Brief__c` — Long Text Area or Rich Text Area (`textarea::` prefix in Zapier confirms)
- `R360_Last_AI_Contact_Brief__c` — DateTime (date the brief was last generated)

These fields must exist in BOTH UAT and prod. Validate via the 22-ID audit script (see `runbooks/pre-cutover-validation.md` §4).

### 8.10 Error paths

| Scenario | Behavior | Log entry |
|---|---|---|
| Webhook missing required field | Halt with 400 response | `Status='failed'`, `Error_Message='Pre-Discovery rejected: missing required field <name>'` |
| SF lookup miss (Account/Contact/User) | Halt | `Status='failed'`, `Error_Message='SF lookup miss: <object> by <id>'` |
| Perplexity 120s timeout | Retry once with 30s backoff. On 2nd timeout, log + Slack-page. | `Status='failed'`, `Error_Message='Perplexity timeout after retry'` |
| Apollo 0-result match | Continue to ChatGPT without enrichment data; log warning | `Status='written'` (success path), `Error_Message='Apollo: no match'` (warning, not failure) |
| GPT 400k token limit hit | Re-run with reduced inputs (truncate Perplexity output to 64k chars) | `Status='written'` after retry |
| `User.Slack_ID__c` missing | Skip Slack DM for that recipient; fall back to email-only notification via Gmail SMTP | `Status='written'`, `Error_Message='Slack DM skipped: AE.Slack_ID__c missing'` |
| SF rich-text field FLS denied for integration user | Halt write; Slack-page SF Admin | `Status='failed'`, `Error_Message='FIELD_INTEGRITY_EXCEPTION on Record360_AI_Contact_Brief__c'` |

### 8.11 Component test cases (extends §17.4)

#### C-17 — Pre-Discovery Perplexity timeout retry

**Setup:** Mock Perplexity endpoint to return 200 after 130s on first call, normal response on second call.
**Trigger:** POST to Pre-Discovery webhook with valid `accountId/contactId/ownerEmail` from UAT fixture.
**Expected:** First call times out at 120s, retry fires after 30s backoff, second call succeeds. Workflow completes within 280s. Final SF Contact has populated `Record360_AI_Contact_Brief__c`.

```sql
SELECT Id, Record360_AI_Contact_Brief__c, R360_Last_AI_Contact_Brief__c
FROM Contact WHERE Id = '<uat_contact_id>'
-- Expected: brief HTML populated, timestamp = today's date within ±5min
```

#### C-18 — Apollo 0-result graceful continue

**Setup:** Use a fixture Contact with email `noapollo-fixture@invalid.test` that Apollo cannot match.
**Expected:** Apollo node returns `person: null`, workflow continues, ChatGPT brief generates without enrichment, SF Contact gets brief written, Inbound_Log marked `Status='written'` with warning `Error_Message='Apollo: no match'`. **No FIELD_INTEGRITY_EXCEPTION on `MobilePhone` (empty-key filter prevents blank overwrite).**

```sql
SELECT Id, MobilePhone, Record360_AI_Contact_Brief__c FROM Contact WHERE Id = '<fixture_id>'
-- Expected: MobilePhone unchanged from pre-test value; brief populated
```

#### C-19 — Missing AE Slack_ID__c falls back to email

**Setup:** Strip `Slack_ID__c` from a fixture User in UAT (`UPDATE User SET Slack_ID__c = NULL WHERE Email = '<fixture_ae_email>'`).
**Expected:** Slack DM to AE is skipped; managers (`U02HR1T6PBK`, `U01B0955NEQ`) still receive their DMs; Gmail SMTP fallback fires to AE's email; Inbound_Log warning logged.

```sql
SELECT Id, Status__c, Error_Message__c FROM Lead_Inbound_Log__c
WHERE External_Submission_Id__c = '<test_run_id>' AND Source__c = 'webhook_pre_discovery'
-- Expected: Status='written', Error_Message LIKE '%Slack DM skipped: AE.Slack_ID__c missing%'
```

#### C-20 — HTML→rich-text encoding fidelity

**Input:** ChatGPT brief containing all of: nested bullet lists, Slack `<URL|Label>` links (multiple), bold `*text*`, emojis (🚨 👤 🏢 🔎), and a code-style ERP name.
**Expected:** SF Contact's `Record360_AI_Contact_Brief__c` renders all elements correctly when viewed in SF UI:
- Bullets nested
- All links clickable with correct labels (no raw `<URL|Label>` strings)
- Bold rendered
- Emojis displayed (NOT `&#x1F6A8;` HTML entities — actual chars)
- No `&lt;` / `&gt;` artifacts from over-escaping

**Verification:** Manual screenshot review by SF Admin during Day 5 UAT (binary pass/fail).

---

## 9. SocialIntents Bot R360 Path (Zap 332679789 Path K) — Deep Spec

**Source of truth:** `migration-plans/specs/spec_bot_book_a_demo.md` §5–§7.
**Scope:** ONLY the R360 detection branch (Path K) of Zap 332679789. The POR side (Path J) stays in Zapier; this migration does not touch it.
**Topology:** SocialIntents webhook → GPT classification → R360 persona detection → normalize to WPForms shape → route through `sub-r360-resolver` → `sub-r360-writer` (same downstream chain as the WPForm receivers).

### 9.1 Persona detection logic — case-sensitive 3-location match

The bot conversation can be handled by the "Rena Record" or "Rosie" personas (R360 product line) OR by "Penny Pointer" / others (POR product line). The detection logic checks THREE nested locations in the SocialIntents payload because the `agent_nickname` field has been seen in different positions across SI versions.

**n8n Code node (`Is R360?`):**

```js
// Inputs:
//   $json.GPT  = parsed GPT classification output (object)
//   $json.raw  = raw SocialIntents POST body (object)

let data = $json.GPT;
if (typeof data === 'string') {
  try { data = JSON.parse(data); }
  catch (e) { return [{ json: { result: 'False', match: false, error: 'Invalid JSON' } }]; }
}

let isRena = false;

// Location 1: top-level user_info.ids.agent_nickname OR user_info.agent_nickname
const summaryNickname =
  data?.user_info?.ids?.agent_nickname ||
  data?.user_info?.agent_nickname;
if (summaryNickname && (summaryNickname.includes('Rena Record') || summaryNickname.includes('Rosie'))) {
  isRena = true;
}

// Location 2: items[*].nickname (loop — match if ANY element matches)
if (!isRena && Array.isArray(data.items)) {
  isRena = data.items.some(item =>
    item.nickname && (item.nickname.includes('Rena') || item.nickname.includes('Rosie'))
  );
}

// Location 3: parse output_text as JSON if present, else grep raw text
//   *** FLAGGED AS UNRELIABLE — validate against live payload before cutover (see §9.4) ***
if (!isRena && data.output_text) {
  try {
    const nested = JSON.parse(data.output_text);
    const nestedNickname = nested?.user_info?.ids?.agent_nickname;
    if (nestedNickname && (nestedNickname.includes('Rena Record') || nestedNickname.includes('Rosie'))) {
      isRena = true;
    }
  } catch (e) {
    if (data.output_text.includes('Rena') || data.output_text.includes('Rosie')) {
      isRena = true;
    }
  }
}

return [{ json: { result: isRena ? 'True' : 'False', match: isRena } }];
```

**Output feeds a Switch node:**
- `match === true` → R360 path (this migration)
- `match === false` → POR path (existing Zapier flow — out of scope; n8n receiver returns 200 and exits)

**Why case-sensitive `includes()` is OK:** Rena/Rosie are persona names, written exactly. Visitors don't type them; they're set in SocialIntents bot config and stable. The fragility is in WHICH field SI puts them — hence the 3-location check.

### 9.2 Bot extras vs WPForms — payload contract differences

The bot payload arrives with a SocialIntents-shaped body, NOT a WPForms-shaped body. Specifically, the bot includes 5 fields that no WPForm carries:

| Field | Type | Source in SI payload | Used by |
|---|---|---|---|
| `note` | string | bot summary / chat transcript | SF Lead/Contact `Description` field; CampaignMember `Notes__c` |
| `requestedTime` | string (ISO datetime) | bot's parsed meeting request | SF `Demo_To_Do_Date__c` (when meeting confirmed) |
| `requestedTimeZone` | string | bot's parsed timezone | log only (no SF field today) |
| `MQLdate` | string (ISO date) | bot timestamp | SF `MQD__c` for path D (existing-contact-not-customer) |
| `role` | string | bot's parsed user role (present in GPT output, NOT in Path K outbound payload — see spec lines 109/233) | log only (could feed `Title` in future) |

The standard semantic WPForms fields (BusinessEmail, FirstName, LastName, CompanyName, PhoneNumber, YourIndustry, YourRegion, utm*) are bot-collected per the Path K payload (spec line 338). **`gclid/fbc/fbp/msclkid` tracking IDs are NOT enumerated in the spec's Path K outbound list** — they may be collected by the bot in a `tracking` object (the §9.3 Set node assumes `$json.tracking.*`) but this path is **unverified by the source spec**. Confirm against a live SocialIntents payload during the §9.4 sniffer validation; if absent in production payloads, drop the four tracking fields from the §9.3 Set node.

**Compatibility:** The Text Formatter FN's `pick()` helper (§6.1, lines 192–194) already accepts bot-extras gracefully — it picks the first non-empty value from a fallback list. Bot extras flow through the resolver and land in the writer without modifying §6.1 code.

### 9.3 Normalization to WPForms shape — Set node

After the R360 detection Switch returns `match=true`, normalize the bot payload to the same shape `sub-r360-resolver` expects (so we reuse the same resolver/writer chain).

**n8n Set node (`Normalize bot to WPForms`):**

```
{
  "source":          "bot_r360",
  "WPFormName":      "BotBookADemo",
  "wpformsEntryId":  "{{ $json.id || $json.conversation_id || $json.timestamp }}",
  "BusinessEmail":   "{{ $json.user_info.email }}",
  "FirstName":       "{{ $json.user_info.first_name || $json.user_info.firstName }}",
  "LastName":        "{{ $json.user_info.last_name || $json.user_info.lastName }}",
  "CompanyName":     "{{ $json.user_info.company || $json.domain_research.company }}",
  "PhoneNumber":     "{{ $json.user_info.phone }}",
  "YourIndustry":    "{{ $json.industry || $json.user_info.industry }}",
  "YourRegion":      "{{ $json.domain_research.region }}",
  "utmSource":       "{{ $json.page.utm.utm_source }}",
  "utmMedium":       "{{ $json.page.utm.utm_medium }}",
  "utmCampaign":     "{{ $json.page.utm.utm_campaign }}",
  "utmTerm":         "{{ $json.page.utm.utm_term }}",
  "utmContent":      "{{ $json.page.utm.utm_content }}",
  "gclid":           "{{ $json.tracking.gclid }}",
  "fbc":             "{{ $json.tracking.fbc }}",
  "fbp":             "{{ $json.tracking.fbp }}",
  "msclkid":         "{{ $json.tracking.msclkid }}",
  "note":            "{{ $json.summary }}",
  "requestedTime":   "{{ $json.meeting.salesforce_datetime }}",
  "requestedTimeZone": "{{ $json.meeting.timeZone }}",
  "MQLdate":         "{{ $now.toFormat('yyyy-MM-dd') }}"
}
```

After this Set node, the payload is identical in shape to a Contact Form 29710 submission. The resolver and writer don't need to know it came from a bot.

**Region bug to fix during migration:** The Zap reads `domain_research.supplemental.region` (per `spec_bot_book_a_demo.md` Differences Summary), but the GPT prompt puts `region` at `domain_research.region` (top-level). The Set node above reads `domain_research.region` — which fixes the bug. Validate in T22 in §17.5.

### 9.4 Live-payload validation — pre-cutover task

**Problem:** the 3-location persona detection logic is best-effort. Real production SocialIntents payloads have not been verified against the spec's claimed shape. Before cutover, capture real payloads and confirm the detection actually fires.

**Pre-cutover runbook task** (also in `runbooks/pre-cutover-validation.md` §3):

1. Deploy a temporary n8n webhook (`/webhook/r360/bot-sniffer`) that does NOTHING but log the entire POST body to a flat file or n8n execution history.
2. Configure SocialIntents to POST to the sniffer endpoint **alongside** the existing Zapier URL (dual-write to sniffer for 24h).
3. After 24 hours, retrieve at least:
   - **3 R360 conversations** (where Rena Record or Rosie was the agent)
   - **3 POR conversations** (Penny Pointer or others)
   - **2 ambiguous** (anonymous visitor, no clear persona signal)
4. Run the §9.1 detection logic against all 8 captured payloads:
   - All 3 R360 → `match=true` ✓
   - All 3 POR → `match=false` ✓
   - 2 ambiguous → either result acceptable, BUT must be deterministic (same input → same output)
5. If ANY R360 false-negative (we'd lose an R360 lead) → STOP. Re-design detection logic with the real payload structure.
6. If ANY POR false-positive (we'd misroute a POR lead to R360) → STOP. Re-design.

**Output:** signed-off go/no-go entry in pre-cutover Day 0 readiness checklist (`runbooks/pre-cutover-validation.md` §7).

### 9.5 What stays in Zapier (out of scope)

- **Zap 332679789 Path J** (POR side, gmail/yahoo/etc) remains active in Zapier. No migration touch.
- **Zap 334059875** (Thank You Bot Book A Demo, post-conversation native trigger) remains active in Zapier. No R360 path; entirely POR.
- **Zaps 314287758, 320314965, 343296525** (POR Pre-Discovery, etc.) remain active in Zapier. Out of scope.

The bot Zap 332679789 stays partially active even after R360 cutover: only the Path K branch's outbound POST is replaced by SocialIntents-direct-to-n8n. The Zap's own R360 detection logic still runs (harmlessly, since its outbound URL is now a no-op). Phase B Zapier-off plan accounts for this — see §18 Cutover Phase B step 4.

---

## 10. CampaignMember Field Maps

Pattern: every "add to campaign" is followed by Find CampaignMember by SOQL → Update CampaignMember.

```
WHERE: CampaignId = '701Ki000000cMwkIAE' AND (ContactId = :contactId OR LeadId = :leadId)

Update CampaignMember fields:
  Status:    'Cold / Not Started'
  Notes__c:  'Form Filled: {{WPFormName}}\n
              Form Fill Date: {{today}}\n
              Message: {{note || formContactMessage}}\n
              ROI Calculator: {{roiCalculator}}\n
              UTM Source: {{utmSource}}\n
              UTM Medium: {{utmMedium}}\n
              UTM Campaign: {{utmCampaign}}\n
              UTM Term: {{utmTerm}}\n
              UTM Content: {{utmContent}}'
```

The 6 Find/Update CampaignMember pairs in the spec all follow this pattern:

| Pair | Find node | Update node | Triggered by |
|---|---|---|---|
| 1 | 316797651 | 316797652 | Path A4b — Lead Campaign |
| 2 | 316797664 | 316797665 | Path B — Lead Campaign |
| 3 | 316797633 | 316797634 | Path A4a — Lead/Contact Campaign |
| 4 | 316797620 | 316797621 | Path A4c-i — Contact Campaign |
| 5 | 316797677 | 316797678 | Path C — Contact Campaign (AM) |
| 6 | 316797584 | 316797585 | Path D — Contact Campaign (SDR) |

Hardcoded campaign ID `701Ki000000cMwkIAE` (R360 Website Campaign).

---

## 11. Hardcoded SF ID Inventory (22 IDs — Day 1 validation table)

n8n reads these IDs from environment variables (`SF_R360_LEAD_RT`, `SF_R360_LEAD_ACCT_APAC`, etc.) so the same workflow JSON deploys to UAT and prod with different bindings.

| Category | ID | Purpose | Validation SOQL |
|---|---|---|---|
| Lead RecordType | `012Ki000000bpgRIAQ` | R360 Lead RT | `SELECT Id FROM RecordType WHERE Id = '012Ki000000bpgRIAQ'` |
| Case RecordType | `0124u000000l5qwAAA` | Inside Sales Case RT | `SELECT Id FROM RecordType WHERE Id = '0124u000000l5qwAAA'` |
| Campaign | `701Ki000000cMwkIAE` | R360 Website Campaign | `SELECT Id, Name, IsActive FROM Campaign WHERE Id = '701Ki000000cMwkIAE'` |
| Account (APAC) | `001Ki000009wWMPIA2` | R360 Lead Account — APAC | `SELECT Id, Name FROM Account WHERE Id = '001Ki000009wWMPIA2'` |
| Account (Europe) | `001Ki000009wWM0IAM` | R360 Lead Account — Europe | same pattern |
| Account (NA) | `0014u00002BFXvRAAX` | R360 Lead Account — North America | same |
| Queue (APAC) | `00G0L000004WbECUA0` | Inside Sales Queue — APAC | `SELECT Id, Name FROM Group WHERE Id = '00G0L000004WbECUA0' AND Type = 'Queue'` |
| Queue (Africa) | `00G4u000004AmQJEA0` | Inside Sales Queue — Africa | same |
| Queue (Europe) | `00G0L000004WbEDUA0` | Inside Sales Queue — Europe | same |
| Queue (NA / SA / default) | `00G0L000004WbEEUA0` | Inside Sales Queue — NA | same |
| BusinessHours (APAC) | `01m0L00000001OZQAY` | APAC business hours | `SELECT Id, Name FROM BusinessHours WHERE Id = '01m0L00000001OZQAY'` |
| BusinessHours (EMEA/Africa) | `01m0L00000001PcQAI` | EMEA hours | same |
| BusinessHours (NA default) | `01m0h0000005HbeAAE` | NA hours | same |
| User — Josh O'Connell (APAC AE) | `0050L000008hH5DQAU` | AE assignment | `SELECT Id, Name, IsActive, Slack_ID__c FROM User WHERE Id = '0050L000008hH5DQAU'` |
| User — Dean Hammond (Europe AE) | `0050L000008uAHvQAM` | AE | same |
| User — Katie McFarland (NA / SA / Africa default AE) | `0054u0000094ck7AAA` | AE | same |
| (Commented out) Bernice Smith | `0054u000006ZVWdAAO` | dead code in switch | n/a |
| SF auth credential 1 | `60379987` | n8n migration: pick ONE | confirm in Zapier |
| SF auth credential 2 | `51104497` | n8n migration: deprecate | confirm in Zapier |
| Slack bot token (R360) | `60379987` | DM token | confirm |
| Slack bot token (R360 Pre-Discovery variant) | `51104497` | Pre-Discovery uses this | confirm |
| Slack hardcoded manager 1 | `U01B0955NEQ` | always-cc on Pre-Discovery DM | n/a |
| Slack hardcoded manager 2 | `U02HR1T6PBK` | always-cc on Pre-Discovery DM | n/a |

**Day 1 task:** run all SOQL queries above against `por-prod`. Any 0-row result is a blocker. Specifically check that `User.Slack_ID__c` is populated for Josh, Dean, Katie.

---

## 12. Per-Action Error Sub-Branch Table

12 SF write actions in the central processor, each with a Success/Error filter pair. In n8n, replace each Zapier "Filter Error path" with a Try/Catch wrapper:

| SF action | Node | Success goes to | Error goes to |
|---|---|---|---|
| Create Lead (Path A4b) | 316797589 | add_lead_to_campaign 334669861 | Slack `#r360-leads-errors` (channel `C06TTMZB3RA`), update Inbound_Log Status="failed" |
| Update Lead (Path B) | 316797571 | add_lead_to_campaign 316797574 | Same error sink |
| Update Lead (Path A4a) | 316797638 | add_lead_to_campaign 316797641 | Same |
| Update Contact (Path A4c-i — has /f bug) | 316797607 | add_contact_to_campaign 316797614 | Same |
| Update Contact (Path A4c-ii) | 316797625 | Create Case 316797628 | Same |
| Update Contact (Path C — AM) | 316797656 | Create Case 316797659 | Same |
| Update Contact (Path D — SDR) | 316797669 | Gmail → add_contact_to_campaign 316797673 | Same |
| Create Case (Path A4c-ii) | 316797628 | add_contact_to_campaign 316797629 | Same |
| Create Case (Path C — AM) | 316797659 | add_contact_to_campaign 316797660 | Same |
| Convert Lead to Contact (HTTP node — §7.8) | 340057313 | Send Lead Converted Email | Same |
| Add Lead to Campaign (×3) | 334669861, 316797641, 316797574 | Find/Update CampaignMember | Same |
| Add Contact to Campaign (×4) | 316797614, 316797629, 316797660, 316797673 | Find/Update CampaignMember | Same |

Every error path writes to `Lead_Inbound_Log__c` with `Status__c = 'failed'`, `Error_Message__c = <stack + SF error>`, `Retry_Count__c += 1`, then posts to `#r360-leads-errors`.

---

## 13. Lead_Inbound_Log__c + Reconciliation (0-Miss Guarantee)

### 11.1 New SF object — `Lead_Inbound_Log__c`

Every payload logged before processing. R360-specific picklist values for `Source__c`:

| Picklist value | Meaning |
|---|---|
| `wpform_29710` | R360 Contact Form |
| `wpform_29712` | R360 Watch a Video |
| `wpform_29714` | R360 Get a Demo |
| `bot_r360` | SocialIntents R360 branch (Zap 332679789 Path K) |
| `webhook_pre_discovery` | R360 Pre-Discovery (Zap 336544812) |
| `wpform_33076` | R360 FAQ (Zap 225753704) |

Required fields: `Idempotency_Hash__c` (External ID Unique, indexed), `External_Submission_Id__c`, `Status__c`, `Decision_Path__c`, `Resolved_Lead__c`, `Resolved_Contact__c`, `Payload__c`, `Error_Message__c`, `Retry_Count__c`, `Received_At__c`, `n8n_Execution_Id__c`.

**Idempotency hash:** `sha256(form_id + ":" + entry_id)`. Receiver upserts the log row using `Idempotency_Hash__c` as the external ID. If the row already exists with `Status__c = "written"`, exit immediately as duplicate.

### 11.2 WPForms Reconciliation cron — `cron/r360-wpforms-reconciliation.json`

> **Status (2026-05-10, revised): IN SCOPE for v1.** Per Kirk, after considering that real-time WPForms webhooks alone can't prove 100% lead capture, the 10-minute MySQL reconciliation cron is back IN-SCOPE for v1. WordPress DB read-only credentials become a Day-0 blocker again. **Why:** without DB access, the only way to detect a dropped webhook is sales-team feedback — slow and unreliable. With DB access, n8n catches and auto-replays any missed entry within 10 minutes via the existing `cron/r360-wpforms-reconciliation.json` workflow. The cron is already built; just needs the credential bound + activation.

**Architecture correction (replaces prior REST API approach):** runs every 10 minutes, queries WordPress DB directly via the `wp_wpforms_entries` table.

```sql
-- Read-only DB credential bound to n8n
SELECT entry_id, form_id, fields, date_created
FROM wp_wpforms_entries
WHERE form_id IN (29710, 29712, 29714, 33076)
  AND date_created > FROM_UNIXTIME({{ $staticData.lastCheckedAt[form_id] }})
ORDER BY date_created ASC
LIMIT 200
```

For each entry returned:
1. Compute `idempotencyHash = sha256(form_id + ":" + entry_id)`.
2. Query `Lead_Inbound_Log__c WHERE Idempotency_Hash__c = :hash`.
3. If row exists → skip.
4. If missing → POST to the matching n8n receiver (`/webhook/r360/contact-form` etc.) with the entry payload. Mark `Status__c = "replayed"`.
5. Update `staticData.lastCheckedAt[form_id]` only if cron run completed without error.

**Form ID iteration order** (start lowest-volume first):
1. 33076 (FAQ — trivial)
2. 29712 (Watch a Video)
3. 29714 (Get a Demo)
4. 29710 (Contact Form)

### 11.3 Why this works

Even if both the WPForms-Webhook addon AND the WPForms-Zapier addon fail simultaneously, the WPForms entry table inside WordPress still has the submission. The cron pulls it via DB and replays. The idempotency hash prevents double-write if both real-time delivery AND cron deliver the same entry.

### 11.4 Daily report — `cron/r360-daily-leadops.json`

Runs 8am Central. Queries `Lead_Inbound_Log__c` for last 24h scoped to R360 sources. Posts to `#r360-leads-daily`:

```
:bar_chart: R360 lead inbound — last 24h
Total received:     <n>
Successful writes:  <n> (<pct>%)
Failed:             <n>  (<pct>%)
Replayed (recon):   <n>  ← should be 0 most days
Skipped (no email): <n>
Skipped (Contact Form, no record): <n>

By source:
  WPForm 29710 (Contact Form):  <n>
  WPForm 29712 (Watch Video):   <n>
  WPForm 29714 (Get a Demo):    <n>
  Bot R360 (Path K):            <n>
  Pre-Discovery webhook:        <n>
  WPForm 33076 (FAQ):           <n>

By path:
  A4a (update Lead — requery):  <n>
  A4b (create Lead):            <n>
  A4c-i (update Contact, SDR):  <n>
  A4c-ii (update Contact + Case Customer): <n>
  A4d (terminal short-form):    <n>
  B (update Lead initial):      <n>
  C (Customer/AM):              <n>
  D (Not customer/SDR):         <n>

Top 5 errors today:
  ...
```

---

## 14. Error Handling

Every receiver workflow has an `Error Trigger` workflow attached. On any failure:

1. Update `Lead_Inbound_Log__c`: `Status__c = "failed"`, `Error_Message__c = <stack + SF error>`, `Retry_Count__c += 1`.
2. Post to `#r360-leads-errors` Slack:
   ```
   :rotating_light: R360 lead inbound failed
   Source: {{source}} (form_id {{form_id}})
   Email: {{email}}
   Stage: {{failed_node_name}}
   Error: {{message}}
   Inbound_Log: {{SF_link}}
   n8n Run: {{n8n_link}}
   ```
3. If `Retry_Count__c >= 5`, escalate via Gmail SMTP to the `NotificationEmail` from Assignment Owner (region-aware) plus `katie.mcfarland@pointofrental.com`.
4. Workflow exits 500 so n8n's queue mode triggers DLQ retry (3x with exponential back-off: 1s, 5s, 25s).

**DLQ replay cron** (`cron/r360-deadletter-replay.json`, every 5 minutes): re-emit any `Lead_Inbound_Log__c WHERE Status__c='failed' AND Retry_Count__c<5` payloads. After 5 retries, the cron stops trying and the lead requires manual triage.

---

## 15. Bugs and Failure Modes to Fix During Migration (NOT carry over)

12 R360-specific issues surfaced during analysis (5 from the prior plan + 4 newly identified failure modes + 3 architecture issues).

### Pre-existing bugs (carry over from prior plan)

1. **Hardcoded `Most_Recent_Pardot_Form__c = "R360 - Contact Form"`** in nodes 316797589 (Path A4b), 316797571 (Path B), 316797638 (Path A4a), 316797669 (Path D — SDR), and 316797607 (Path A4c-i). Note: Path C (AM, node 316797656) sets this field to `""` (empty), not a hardcoded form name. Should template as `"R360 - " + WPFormName` on affected nodes so Watch Video / Get a Demo / bot are correctly attributed.
2. **Contact Form router sends blank `Timestamp` and `ZapID`** — n8n receivers should set both based on the actual payload.
3. **Path D (SDR, node 316797669) and Path A4c-i (node 316797607) `Description` field uses `{{field7}}` (raw form field) for Phone**, not the normalized `phone`. Fix: use `formattedPhone`. Note: Path C (AM, node 316797656) does NOT have a Description field at all — the bug is on the SDR paths only.
4. **`UTM_Term__c` in Path C (node 316797656) and Path D (node 316797669) uses raw `{{field27}}`** — copy-paste leftover. Fix: use normalized `utmTerm`.
5. **`pi__url__c` (cleaned landing page)** is captured by the formatter (`cleanedLanding`) but never written to any SF field. Fix: add to all 4 paths' field maps.
6. **SOQL injection vulnerability** in the `Create Queries` Code node — `'` in submitter input breaks the query. Fix: escape in §6.3.
7. **Two SF auth credentials** in the central processor today. Fix: standardize on one integration user.
8. **15-minute delay in Watch Video and Get a Demo routers** — confirm with Marketing whether still needed.

### Newly identified failure modes (added by verification swarm)

9. **`/f` prefix on `fbp__c` in Path A4c-i** (node 316797607): hardcoded `string::fbp__c: "/f{{316797554__fbp}}"`. Corrupts the value for Contacts on this path. Fix: drop the `/f` prefix.
10. **Dead-code SOQL queries** in `Create Queries` node — the generated `leadQuery` and `contactQuery` outputs are NOT consumed by the Find Lead / Find Contact nodes (which use their own hardcoded WHERE clauses). The Code node's output is functionally unused. Fix: wire the generated queries into the Find nodes (more robust dedup).
11. **`field14` (Contact Form message body) is captured but only written to CampaignMember.Notes__c**, never to Lead.Description / Contact.Description__c. If the SDR doesn't read CampaignMember Notes, the submitter's message is functionally lost. Fix: write to `Lead.Description` (now applied in §7.1, §7.2) and `Contact.Description__c` (§7.4 for SDR path — replaces raw field7 bug). For Path C (AM), Description is absent from the Zap and would be a net-new addition.
12. **`UTM_Term__c` in Path C (node 316797656) and Path D (node 316797669) uses raw `{{field27}}`** — *(already noted as bug #4 above; reinforced by gap-analysis agent. Fix applies to both paths.)*

### Architecture corrections (from feasibility report)

A1. **WPForms REST API endpoint not confirmed** → switch to WordPress DB polling for reconciliation. (See §13.2.)
A2. **n8n SF node has NO native `convertLead`** → use HTTP Request node sub-workflow. (See §7.8.)
A3. **n8n SF Update node overwrites blanks with empty string** → insert empty-key filter Set node before each update. (See §2.3, applied throughout §7.)

### §15.A — Plauti DupCheck Fallback Pattern (deployed 2026-05-18/19)

**Problem.** The resolver's SOQL dedup logic matches on normalized email against Lead and Contact. For non-public-domain emails, Plauti DupCheck (an Apex trigger installed on `Lead`) can catch a duplicate that the resolver's fuzzy match missed — typically because the existing Lead record has a slightly different name normalization or was created via a different channel. When Plauti fires, SF returns HTTP 400 with body `"Please use one of the existing records, if possible"`. Without recovery, the submission silently fails: `Lead_Inbound_Log__c.Status__c` stays `received`, no Lead is created or updated, no Slack/Gmail notification fires.

**Deployed pattern — both R360 writer (`n12VvtsMqRSUOniR`) and POR writer (`8bgnoj7dfYg4uqBv`):**

1. `SF HTTP: Create Lead` is configured with `onError: continueErrorOutput` (n8n's two-port error handling — port 0 = success, port 1 = error). This replaces the previous single-output wiring that would halt the execution on any Create failure.

2. **Success port (0):** continues to the existing chain — `Code: Build CampaignMember body` → supersede chain → `Code: Build final-update payload` → `SF HTTP: Update Lead_Inbound_Log__c`.

3. **Error port (1):** routes to a four-node fallback chain:
   - `Code: Detect Plauti dup + build SOQL` — inspects the error body. If the message matches the Plauti fingerprint, constructs `SELECT Id FROM Lead WHERE Email = '<exact>' AND IsConverted = false ORDER BY LastModifiedDate DESC LIMIT 1`. If the error is something else entirely (auth, FLS, schema) the code node still emits a record so the chain can reach final-update and log the failure honestly.
   - `SF HTTP: Query Lead by exact email (Plauti-recovery)` — executes the SOQL. `onError: continueRegularOutput` so a zero-row result doesn't halt the chain.
   - `Code: Build Lead update body (Plauti-recovery)` — constructs a Path-B-style update body (same field set as a normal "Lead found" update). Sets `_sf_record_id = foundLeadId`, `leadId = foundLeadId`, `_plauti_recovered = true`. Returns an empty object if the SOQL came back empty (edge case: Plauti said dup but our query found nothing — logs cleanly).
   - `SF HTTP: Update Lead (Plauti-recovery → Path B)` — executes the PATCH. `onError: continueRegularOutput`.
   - Chain merges back into `Code: Build CampaignMember body` (shared with the success path).

4. `Code: Build final-update payload` reads the recovered Lead ID via:
   ```js
   $('Code: Build Lead update body (Plauti-recovery)').first()?.json?.leadId
   ```
   When that value is present, it re-labels `Decision_Path__c` from `A4b` to `B` and populates `Resolved_Lead__c` with the found Lead ID. The `Lead_Inbound_Log__c` row therefore reflects what actually happened (update, not create) rather than the originally intended path.

**Mirrors Zap node 253294318** ("Update Lead after Create fail") — the original Zap had the identical recovery pattern; this is a faithful n8n port.

**When it fires in practice:**
- **POR:** estimated 5–15 % of resubmissions where the resolver's SOQL misses but Plauti catches. POR forms have higher resubmission rates (Contact Us form is reused by existing customers).
- **R360:** rarely in practice. R360 Contact Form routes no-record cases to `X_no_record_skipped_contactform` per §5.4, which never reaches Create Lead. The fallback code is defensive coverage for any future R360 form that exercises Path A4b at scale.

**Why `onError: continueErrorOutput` rather than a retry loop:** Retrying a Plauti-blocked Create would fail identically every time. The correct recovery is to find the existing record and update it — which is what this chain does.

---

## 16. Build Sequence — 7 Days (revised: 1 dedicated SF UAT prep day + 6 build days)

### Day 0 — SF UAT environment prep (PREREQUISITE — must complete before Day 1 starts)

- [ ] Refresh `por-uat` from `por-prod` (or confirm last refresh < 30 days old). Per `sf-deployment-specialist` standard process.
- [ ] Run the **UAT vs Prod ID Mapping** discovery (see §17.2). Capture every R360-relevant record's UAT ID.
- [ ] Provision test users in UAT: SDR (1), AM (1), 4 region-AE accounts (Josh-clone, Dean-clone, Katie-clone-A, Katie-clone-B for round-robin verification), 1 RevOps integration user with the n8n profile assigned.
- [ ] Verify all 22 hardcoded prod IDs from §11 have UAT counterparts. Where UAT IDs differ, document in the mapping table for the n8n config to read at deploy time.
- [ ] Confirm `Lead_Inbound_Log__c` custom object deployed to UAT (delta deploy via `sf-deployment-specialist`). Smoke-test by inserting one row via Workbench.
- [ ] Confirm Plauti DupCheck `dupcheck__dc3DisableDuplicateCheck__c` field exists on Contact in UAT and integration user has FLS write access.
- [ ] Seed UAT `TestDataFactory.cls` with R360-shaped fixtures (3 Accounts: Customer/Prospect/None; 3 Contacts; 3 Leads — one IsConverted=false, one IsConverted=true).
- [ ] **Sign-off gate (SF Admin):** UAT environment ready.

### Day 1 — Foundations + Day-1 procurement

- [ ] Deploy `Lead_Inbound_Log__c` SF custom object to PROD via delta package (per `sf-deployment-specialist`). Validate in `por-uat` first.
- [ ] Stand up n8n production instance (queue mode + Redis + PostgreSQL).
- [ ] Run the 22-ID SOQL validation table (§11) against `por-prod`. Any 0-row result is a blocker.
- [ ] Procure credentials and configs:
  - WPForms Webhook addon enabled on R360 WordPress (or native n8n WPForms Trigger configured)
  - WordPress DB read-only credentials for n8n reconciliation
  - SF integration user OAuth tokens (1 picked from the 2 in use today; permissions verified for Lead/Contact/Account/Case/CampaignMember/`Lead_Inbound_Log__c` write)
  - Slack bot tokens (R360 + Pre-Discovery variants — keep separate per spec)
  - Apollo.io API credentials (Pre-Discovery only)
  - Perplexity API credentials (Pre-Discovery only)
  - OpenAI API credentials (Pre-Discovery only)
  - Live Zapier catch URLs from each of the 4 main zaps (record privately for cutover-phase fallback)
- [ ] Confirm Plauti DupCheck is the installed package and `dupcheck__dc3DisableDuplicateCheck__c` is the correct field API name on Contact.

### Day 2 — Shared sub-workflows

- [ ] Build `sub-normalize-payload.json` (Text Formatter FN, with chatbot fields supported as the `pick()` helper already accepts).
- [ ] Build `sub-r360-resolver.json` — wraps the 11 pre-branch steps including the 15-second ReQuery sub-tree.
- [ ] Build `sub-r360-writer.json` — Switch on decisionPath into 7 sub-paths (A4a, A4b, A4c-i, A4c-ii, A4d, B, C, D), with Set-node empty-key filter before every SF Update.
- [ ] Build `sub-convert-lead.json` — HTTP Request node calling SF REST `convertLead`.
- [ ] Build `sub-notify.json` — Slack DM via `User.Slack_ID__c`, Gmail SMTP with the 5 templates.
- [ ] Build `sub-error-handler.json` — Error Trigger workflow attached to all receivers.

### Day 3 — Phase 1A receivers (4 main R360 zaps)

- [ ] Build `receivers/wpform-r360-contact-form.json` (form 29710, immediate, full payload).
- [ ] Build `receivers/wpform-r360-watch-video.json` (form 29712, optional 15-min wait, email + click IDs only).
- [ ] Build `receivers/wpform-r360-get-demo.json` (form 29714, optional 15-min wait, email + click IDs only).
- [ ] Each calls `sub-r360-resolver` → `sub-r360-writer` → `sub-notify`.
- [ ] End-to-end fixture test against `por-uat`.

### Day 4 — Phase 1B (chatbot R360 branch + Pre-Discovery)

- [ ] Build `receivers/socialintents-r360-branch.json` — webhook listening for "Rena Record" / "Rosie" personas. Detection logic from `spec_bot_book_a_demo.md` §5-7. Payload normalized to the same shape the WPForms receivers produce, then calls the same `sub-r360-resolver`/`sub-r360-writer` chain. The existing POR side of Zap 332679789 stays in Zapier (separate POR migration project).
- [ ] Build `receivers/webhook-pre-discovery-r360.json` (Zap 336544812). Per `spec_pre_discovery_ai_notes.md`: webhook → SF Find Account/Contact/User → Perplexity sonar-deep-research (128k tokens, 60-120s latency — set webhook timeout accordingly OR use async pattern with 200 immediate response + queue) → Apollo enrich (writes back MobilePhone) → ChatGPT gpt-5.1 with 400k tokens + web_search_preview → Slack DM to AE + 2 hardcoded managers → Markdown→HTML formatter → SF Update Contact (`Record360_AI_Contact_Brief__c` HTML brief, `R360_Last_AI_Contact_Brief__c` execution timestamp — fixes Zapier-side blank).

### Day 5 — Reconciliation + Phase 1C + Cron

- [ ] Build `cron/r360-wpforms-reconciliation.json` — every 10 min, queries WordPress DB `wp_wpforms_entries` table for new R360 form submissions since `staticData.lastCheckedAt[form_id]`. For each entry, hash and check `Lead_Inbound_Log__c`. If missing, replay through the matching receiver. Tested with dry-run before going live.
- [ ] Build `cron/r360-deadletter-replay.json` — every 5 min, retries `Lead_Inbound_Log__c WHERE Status__c = 'failed' AND Retry_Count__c < 5`.
- [ ] Build `cron/r360-daily-leadops.json` — 8am Central, posts daily R360 lead-flow summary to `#r360-leads-daily`.
- [ ] Build `receivers/wpform-r360-faq.json` (Zap 225753704, low priority Phase 1C). WPForm 33076 (R360 FAQ) → append row to Google Sheets. Trivial — 2-node port.
- [ ] Run reconciliation dry-run for 24h.
- [ ] Run UAT component tests **C-1 to C-20** (see §17.4 — includes C-17–C-20 from new §8.11).
- [ ] Run UAT load tests **L-1 to L-6** (see §17.6).

### Day 6 — Test + Phase A cutover

- [ ] Run full UAT integration test matrix **T1-T25** (see §17.5).
- [ ] **Sign-off Gate 1 (Code Review):** see §17.7.
- [ ] **Sign-off Gate 2 (Functional UAT):** see §17.7.
- [ ] Phase A cutover: enable n8n receivers in dual-write mode alongside Zapier.
- [ ] Begin parallel-run monitoring on `Lead_Inbound_Log__c` (see §17.8 daily procedure + `runbooks/parallel-run-validation.md`).

After Day 6: 72-hour dual-write soak → **Sign-off Gate 3 (Parity)** → Phase B Zapier-off (sequence: 316698017 → 316701470 → 316797350 → 332679789 R360 path → 316797554 → 336544812 → 225753704) → 14-day post-cutover monitoring.

---

## 17. SF UAT Testing & Verification (`por-uat`)

UAT is the gate, not a step. **No workflow ships to prod until it has passed three sign-off gates** in `por-uat`: **(1) Code Review Gate**, **(2) Functional UAT Gate**, **(3) Parity Gate** (after Phase A dual-write).

### 15.1 UAT Environment Topology

```
n8n-uat.pointofrental.com  ←→  por.my.salesforce.com (--target-org por-uat)
       │                              │
       ├─ webhook receivers           ├─ Lead, Contact, Account, Case, CampaignMember
       ├─ shared sub-workflows        ├─ Lead_Inbound_Log__c (UAT instance)
       ├─ cron schedules              └─ TestDataFactory.cls + UAT seed data
       └─ Error Trigger workflow

WPForms (R360-uat staging WP site OR R360 prod with test-form IDs)
       └─ posts to n8n-uat receivers
```

The SF org is `por-uat` (per `~/.claude/CLAUDE.md`: `sf data query --target-org por-uat`). The n8n UAT instance runs on a separate VPC from prod, with its own Redis + Postgres. Credentials are UAT-specific — no prod tokens in UAT and vice-versa.

### 15.2 UAT vs Prod Hardcoded ID Mapping (Day 0 deliverable)

n8n reads these IDs from environment variables so the same workflow JSON deploys to UAT and prod with different bindings.

| Logical | Prod ID | UAT ID | Source SOQL |
|---|---|---|---|
| R360 Lead RecordType | `012Ki000000bpgRIAQ` | `<uat_id>` | `SELECT Id FROM RecordType WHERE SobjectType='Lead' AND DeveloperName='R360_Lead' --target-org por-uat` |
| Inside Sales Case RT | `0124u000000l5qwAAA` | `<uat_id>` | `SELECT Id FROM RecordType WHERE SobjectType='Case' AND DeveloperName='Inside_Sales' --target-org por-uat` |
| R360 Website Campaign | `701Ki000000cMwkIAE` | `<uat_id>` | `SELECT Id FROM Campaign WHERE Name LIKE 'R360 Website%' AND IsActive=true --target-org por-uat` |
| R360 Lead Account — APAC | `001Ki000009wWMPIA2` | `<uat_id>` | `SELECT Id FROM Account WHERE Name='R360 Lead Account - APAC' --target-org por-uat` |
| R360 Lead Account — Europe | `001Ki000009wWM0IAM` | `<uat_id>` | same pattern |
| R360 Lead Account — North America | `0014u00002BFXvRAAX` | `<uat_id>` | same |
| Inside Sales Queue — APAC | `00G0L000004WbECUA0` | `<uat_id>` | `SELECT Id FROM Group WHERE DeveloperName='Inside_Sales_APAC' AND Type='Queue' --target-org por-uat` |
| Inside Sales Queue — Africa | `00G4u000004AmQJEA0` | `<uat_id>` | same |
| Inside Sales Queue — Europe | `00G0L000004WbEDUA0` | `<uat_id>` | same |
| Inside Sales Queue — NA/SA/default | `00G0L000004WbEEUA0` | `<uat_id>` | same |
| BusinessHours — APAC | `01m0L00000001OZQAY` | `<uat_id>` | `SELECT Id FROM BusinessHours WHERE Name LIKE 'APAC%' --target-org por-uat` |
| BusinessHours — EMEA | `01m0L00000001PcQAI` | `<uat_id>` | same |
| BusinessHours — NA | `01m0h0000005HbeAAE` | `<uat_id>` | same |
| AE — APAC (Josh) | `0050L000008hH5DQAU` | `<uat_test_user>` | provision `Josh.OConnell.UAT@pointofrental.com.uat` |
| AE — Europe (Dean) | `0050L000008uAHvQAM` | `<uat_test_user>` | provision `Dean.Hammond.UAT@…` |
| AE — Default (Katie) | `0054u0000094ck7AAA` | `<uat_test_user>` | provision `Katie.McFarland.UAT@…` |
| Slack manager-cc 1 | `U01B0955NEQ` | (use UAT Slack channel test user) | n/a |
| Slack manager-cc 2 | `U02HR1T6PBK` | (use UAT Slack channel test user) | n/a |

Once captured, store as `n8n-uat-config.env` and `n8n-prod-config.env` in the n8n credentials manager (NOT in the workflow JSON — separation of concerns).

### 15.3 UAT Test Data Factory

Seeded into `por-uat` on Day 0 via Apex `TestDataFactory.cls` (per `.claude/rules/sf-testing.md`).

| Fixture | Purpose | Properties |
|---|---|---|
| Account `R360_UAT_Customer_NA` | Path C (Customer/AM) | `Status__c='Customer'`, `BillingCountry='United States'`, `Owner=Katie.UAT` |
| Account `R360_UAT_Prospect_NA` | Path D (SDR) | `Status__c='Prospect'`, `BillingCountry='United States'` |
| Account `R360_UAT_Customer_EU` | Path C EU | `Status__c='Customer'`, `BillingCountry='United Kingdom'`, `Owner=Dean.UAT` |
| Contact `R360_UAT_Contact_Customer` (`uat-customer@example.com`) | Path C dedup | linked to `R360_UAT_Customer_NA` |
| Contact `R360_UAT_Contact_Prospect` (`uat-prospect@example.com`) | Path D dedup | linked to `R360_UAT_Prospect_NA` |
| Lead `R360_UAT_Lead_Open` (`uat-lead-open@example.com`) | Path B dedup | `IsConverted=false`, `Status='Open - Not Contacted'` |
| Lead `R360_UAT_Lead_Converted` (`uat-lead-converted@example.com`) | Anti-pattern test | `IsConverted=true` (must be filtered out) |

Re-seed before every UAT run via `sf apex run -f testdata/seed-r360-uat.apex --target-org por-uat`.

### 15.4 UAT Component Test Cases (Days 2-5, before integration matrix)

Each component test specifies a SOQL assertion the SF Admin or n8n developer runs after the test fires.

#### C-1 — Sub-workflow `sub-normalize-payload` (Code: Text Formatter FN)
**Input:** raw WPForm Contact Form payload with `José Müller`, `Acme Co., LLC.`, `josé@example.com`.
**Expected output:** `formattedFirst="Jose"`, `formattedLast="Muller"`, `formattedCompany="Acme Co LLC"`, `formattedEmail="jose@example.com"`, `emailDomain="example.com"`, `utmsource="Marketing: Organic"` (no UTM).
**SF assertion:** none (sub-workflow is pure JS — assert via n8n test runner with Jest-style snapshot).

#### C-2 — `sub-r360-resolver` — Path A (no Lead, no Contact)
**Input:** brand-new email `uat-newlead@example.com`, full Contact Form payload.
**Expected:** Resolver returns `decisionPath: "A_create_lead"`, `leadId: null`, `contactId: null`, `accountId: null`, `ownerId: <Katie.UAT.Id>`, `leadAccountId: <NA_uat_account>`.
**SF assertion (pre-test):**
```sql
SELECT COUNT() FROM Lead WHERE Email = 'uat-newlead@example.com'
-- Expected: 0
```

#### C-3 — `sub-r360-resolver` — Path B (existing open Lead)
**Input:** email `uat-lead-open@example.com` (seeded fixture).
**Expected:** `decisionPath: "B_update_lead"`, `leadId: <fixture.id>`.
**SF assertion (pre-test):**
```sql
SELECT Id, Email, IsConverted FROM Lead WHERE Email = 'uat-lead-open@example.com'
-- Expected: 1 row, IsConverted=false
```

#### C-4 — `sub-r360-resolver` — Path B excludes converted Leads
**Input:** email `uat-lead-converted@example.com` (seeded with IsConverted=true).
**Expected:** `decisionPath: "A_create_lead"` (NOT Path B — converted Leads are filtered out by the SOQL `IsConverted = false`).
**SF assertion:** verify the SOQL in `sub-r360-resolver` Find Lead step matches: `email = ? AND LastName LIKE '%?%' AND IsConverted = false`.

#### C-5 — `sub-r360-resolver` — Path C (Customer)
**Input:** email `uat-customer@example.com`.
**Expected:** `decisionPath: "C_update_contact_AM"`, `contactId: <fixture>`, `accountId: <fixture>`, `accountStatus: "Customer"`, `ownerId: <Account.OwnerId = Katie.UAT>`.
**SF assertion (pre-test):**
```sql
SELECT Id, AccountId, Account.Status__c FROM Contact WHERE Email = 'uat-customer@example.com'
-- Expected: 1 row, Account.Status__c='Customer'
```

#### C-6 — `sub-r360-resolver` — Path D (Prospect)
**Input:** `uat-prospect@example.com`.
**Expected:** `decisionPath: "D_update_contact_SDR"`, `accountStatus: "Prospect"`.

#### C-7 — `sub-r360-resolver` — ReQuery sub-tree A4a
**Input:** email `uat-newlead-2@example.com` BUT pre-test inject a Lead via Workbench 5 seconds before the test fires (simulates a parallel Pardot lead that lands during the 15s window).
**Expected:** initial Find returns null; ReQuery 15-sec wait; Re-Find returns the injected Lead; `decisionPath: "A4a_lead_found_after_requery"` → routes to update_lead, NOT create.
**SF assertion (post-test):**
```sql
SELECT COUNT() FROM Lead WHERE Email = 'uat-newlead-2@example.com'
-- Expected: 1 (NOT 2 — no duplicate created)
```

#### C-8 — `sub-r360-writer` — Path A4b creates Lead with all 38 fields
**SF assertion (post-test):**
```sql
SELECT Id, FirstName, LastName, Company, Email, RecordTypeId, OwnerId,
       LeadSource, MQL__c, R360_Record__c, Raw_Marketing_Lead__c,
       Most_Recent_Pardot_Form__c,
       pi__utm_source__c, pi__utm_medium__c, pi__utm_campaign__c,
       pi__utm_content__c, pi__utm_term__c,
       utm_source__c, utm_medium__c, utm_campaign__c, utm_term__c,
       fbc__c, fbp__c, gclid__c, msclkid__c,
       Sales_Notes__c, Discovery_Notes__c, Lead_Override_Date__c,
       Country, MobilePhone, Phone, IsConverted,
       HasOptedOutOfEmail, HasOptedOutOfFax, DoNotCall
FROM Lead WHERE Email = 'uat-newlead@example.com'
-- Expected: 1 row, RecordTypeId=<R360 UAT RT>, MQL__c=true, R360_Record__c=true,
--   Raw_Marketing_Lead__c=true, Most_Recent_Pardot_Form__c='R360 - ContactForm' (post-bug-fix),
--   utm_* and pi__utm_* both populated, all 4 click IDs present, IsConverted=false
```

#### C-9 — `sub-r360-writer` — empty-key filter preserves existing fields
**Input:** Path B, source payload omits FirstName/LastName/Company.
**Pre-test:** `SELECT FirstName, LastName, Company FROM Lead WHERE Email = 'uat-lead-open@example.com'` (capture values).
**Post-test:** re-query — FirstName/LastName/Company values UNCHANGED.

#### C-10 — `sub-r360-writer` — Path D (SDR) sets `dupcheck__` flag and `Lead_Owner__c`
> DRIFT-2 corrected: `dupcheck__dc3DisableDuplicateCheck__c` and `Lead_Owner__c` are on Path D (SDR), NOT Path C (AM). Verifying against the prospect fixture, not the customer fixture.

**SF assertion:**
```sql
SELECT Id, dupcheck__dc3DisableDuplicateCheck__c, Lead_Owner__c, OwnerId, MQL__c
FROM Contact WHERE Email = 'uat-prospect@example.com'
-- Expected: dupcheck__dc3DisableDuplicateCheck__c=true, Lead_Owner__c=<SDR assignment ID>,
--   MQL__c=true (also SDR-only field)
```

#### C-11 — `sub-r360-writer` — Path C (AM/Customer) creates Case
> DRIFT-2 corrected: Case is created on Path C (AM/Customer), NOT Path D. Verifying against the customer fixture.

**SF assertion:**
```sql
SELECT Id, RecordTypeId, OwnerId, ContactId, Subject, Origin, Status, Priority,
       Type, Campaign__c, BusinessHoursId
FROM Case
WHERE ContactId IN (SELECT Id FROM Contact WHERE Email='uat-customer@example.com')
  AND CreatedDate = TODAY
-- Expected: 1 row, RecordTypeId=<Inside_Sales UAT RT>, Origin='Web',
--   Status='New', Subject='R360 - Contact Form', Type='R360 Sales',
--   Campaign__c='<R360_UAT_Campaign_Id>'
```

#### C-12 — `sub-r360-writer` — CampaignMember Status and Notes update
**SF assertion (after Path A4b test):**
```sql
SELECT Id, Status, Notes__c FROM CampaignMember
WHERE CampaignId = '<R360_UAT_Campaign_Id>'
  AND LeadId IN (SELECT Id FROM Lead WHERE Email = 'uat-newlead@example.com')
-- Expected: 1 row, Status='Cold / Not Started',
--   Notes__c contains 'Form Filled: ContactForm' AND ROI Calculator value
```

#### C-13 — `sub-convert-lead` — HTTP node converts Lead
**Input:** Lead Id of `uat-lead-open@example.com`, plus regional accountId.
**Expected:** HTTP 201 from SF, response includes `contactId`, `accountId`, `opportunityId`.
**SF assertion:**
```sql
SELECT Id, IsConverted, ConvertedContactId, ConvertedAccountId, ConvertedOpportunityId
FROM Lead WHERE Id = '<original_lead_id>'
-- Expected: IsConverted=true, all three Converted* IDs populated
```

#### C-14 — `sub-error-handler` — failure logs to Inbound_Log + Slack
**Trigger:** force a SF Update to fail (e.g., remove FLS access on `MQL__c` for the integration user temporarily).
**Expected:** workflow catches; `Lead_Inbound_Log__c.Status__c = 'failed'`, `Error_Message__c` contains the SF FIELD_INTEGRITY_EXCEPTION; Slack channel `#r360-leads-errors-uat` receives the alert.
**SF assertion:**
```sql
SELECT Id, Status__c, Error_Message__c, Retry_Count__c
FROM Lead_Inbound_Log__c
WHERE Idempotency_Hash__c = '<test_hash>'
-- Expected: Status__c='failed', Retry_Count__c=1, Error_Message__c LIKE '%FIELD_INTEGRITY_EXCEPTION%'
```

#### C-15 — `sub-error-handler` — DLQ replay cron retries
**Setup:** seed 5 `Lead_Inbound_Log__c` rows with `Status__c='failed'` and `Retry_Count__c < 5`.
**Expected:** within 5 min, cron triggers replay, all 5 rows progress to `Status__c='written'` OR `Retry_Count__c++`.

#### C-16 — Reconciliation cron — DB poll picks up missed entry
**Setup:** insert a row directly into UAT `wp_wpforms_entries` (use a UAT-staging WP site) with `form_id=29710` and a unique entry ID. Do NOT trigger the WPForms webhook.
**Expected:** within 10 min, cron polls DB, finds the entry, computes hash, finds no matching `Lead_Inbound_Log__c`, fires the receiver as a replay. Lead created.
**SF assertion:**
```sql
SELECT Id, Source__c, Status__c, External_Submission_Id__c
FROM Lead_Inbound_Log__c
WHERE External_Submission_Id__c = '<wp_entry_id>' AND Source__c = 'wpform_29710'
-- Expected: 1 row, Status__c='replayed'
```

### 15.5 UAT Integration Test Matrix — 25 cases against `por-uat`

After component tests pass on Day 5, run the full integration matrix on Day 6.

| # | Scenario | Form | Expected Path | Expected SF Result |
|---|---|---|---|---|
| T1 | Brand new email/company, valid Contact Form fill | 29710 | A4b | New Lead created, RecordTypeId=R360, OwnerId=region-mapped AE, Campaign added |
| T2 | Email matches existing R360 Lead (IsConverted=false) | 29710 | B | Lead updated, no new Lead, Campaign updated |
| T3 | Email matches existing Contact, Account.Status="Customer" | 29710 | C | Contact updated (OwnerId=AM), Case created (node 316797659), CampaignMember Sales_Case_Associated__c set. No dupcheck or Lead_Owner__c (AM path). |
| T4 | Email matches Contact, Account.Status="Prospect" | 29710 | D | Contact updated with `dupcheck__dc3DisableDuplicateCheck__c=true`, `Lead_Owner__c` and `MQL__c` set. No Case created. |
| T5 | Email empty | 29710 | X_skipped_no_email | No SF write, Inbound_Log status="X_skipped_no_email" |
| T6 | Watch Video form (no name/company) | 29712 | A4b or B | Lead created/updated using ONLY email match (no LIKE LastName) |
| T7 | Get a Demo form (no name/company) | 29714 | A4b or B | Same as T6 |
| T8 | Contact Form with no Lead AND no Contact match | 29710 | X_no_record_skipped_contactform | No write, log status reflects skip |
| T9 | gmail.com submitter | 29710 | (any) | `Create Queries` uses public-domain branch — match by company name fuzzy |
| T10 | Corporate email (acme.com) | 29710 | (any) | `Create Queries` uses corporate branch — match by `Email_Domain__c` |
| T11 | UTM/GCLID/FBC/FBP/MSCLKID set | 29710 | A4b | All tracking fields written to Lead |
| T12 | YourRegion = "Europe" | 29710 | A4b | OwnerId = Dean Hammond UAT user, LeadAccountId = R360 EU Account |
| T13 | YourRegion = "Australia & New Zealand" | 29710 | A4b | OwnerId = Josh O'Connell UAT user, LeadAccountId = R360 APAC Account |
| T14 | SF rate-limit (mock 429) | 29710 | A4b | Workflow retries 3x then DLQ; Inbound_Log status="failed", Retry_Count=1; cron picks up and retries 5 more times |
| T15 | Duplicate submission (same payload twice within 1 min) | 29710 | A4b then short-circuit | Only one Lead created; second receiver call exits at idempotency check |
| T16 | Reconciliation cron replay (entry never hit webhook) | 29710 | A4b | Lead created via cron-fired receiver; log marked Status="replayed" |
| T17 | SOQL injection attempt — submitter puts `'); DROP TABLE` in CompanyName | 29710 | A4b | Single quote escaped; no SOQL injection executes |
| T18 | Submitter has special characters in name (`José Müller`) | 29710 | A4b | `stringFormatter` strips diacritics → "Jose Muller", Lead created |
| T19 | Failed Slack DM (AE has no Slack_ID__c) | 29710 | A4b | Lead created successfully; Slack failure logs warning but doesn't fail the run |
| T20 | Watch Video router 15-min delay | 29712 | A4b | Receiver waits 15 min before processing |
| **T21** | Update existing Contact, source payload omits FirstName/LastName/Company | 29710 | B/C/D | Empty-key filter strips them; Contact's existing FirstName/LastName/Company preserved |
| **T22** | SocialIntents Bot — "Rena Record" persona conversation ends | bot_r360 | (any) | n8n receiver detects R360 trigger, normalizes chatbot payload (with note/requestedTime/MQLdate fields), routes through R360 resolver/writer, produces same SF outcome as a Contact Form fill |
| **T23** | Pre-Discovery webhook fires post-meeting | webhook_pre_discovery | n/a | Perplexity + Apollo + GPT chain runs in <120s OR returns 200 immediately and processes async; SF Contact's `Record360_AI_Contact_Brief__c` populated with HTML; `R360_Last_AI_Contact_Brief__c` set to execution timestamp; Slack DM to AE + 2 managers |
| **T24** | Convert Lead via HTTP node | 29710 | A4a → convert | `sub-convert-lead` calls SF REST, returns contactId/accountId/opportunityId; pipe wires correctly into the post-conversion Campaign add |
| **T25** | WPForms reconciliation cron picks up an entry that bypassed real-time delivery | 29710 | A4b (replay) | DB poll finds `wp_wpforms_entries` row with no matching `Lead_Inbound_Log__c.Idempotency_Hash__c` → triggers receiver replay → log marked Status="replayed" |

**Acceptance criteria for Functional UAT Gate (Gate 2):**
- All 16 component tests (C-1 to C-16) pass.
- All 25 integration tests (T1-T25) pass.
- No FIELD_INTEGRITY_EXCEPTION or REQUIRED_FIELD_MISSING errors in `Lead_Inbound_Log__c.Error_Message__c` for the integration user.
- SF Admin runs full SOQL audit: every Lead/Contact/Account/Case/CampaignMember created during UAT matches the field-map specs in §7 verbatim.

### 15.6 UAT Performance & Load Tests (Day 5 afternoon, before Gate 2)

Real-world R360 lead volume averages ~50 form fills/day, peaking at ~200/day during marketing campaigns. Production must handle 10× peak (2,000/day, sustained) without dropping anything.

| # | Test | Method | Pass criteria |
|---|---|---|---|
| L-1 | Steady-state (50/hr for 1hr) | Replay 50 fixture variations/hr from a script via the receiver webhook URLs | All 50 land in `Lead_Inbound_Log__c` with `Status__c='written'`, no `Status__c='failed'`, p95 latency < 5s end-to-end |
| L-2 | Spike (200 in 60 sec) | Concurrent fixture replay | All 200 enqueue, no webhook 429 / 500 from n8n. Bull queue depth peaks <500. All 200 process within 5 min |
| L-3 | Sustained (2,000 over 24hr) | Replay loop on schedule | n8n queue mode handles without backpressure; UAT SF org's daily API call limit not exceeded |
| L-4 | Concurrent same-email (5x within 1s) | Same email submitted 5 times in parallel | Only 1 Lead created (idempotency hash); other 4 short-circuit; `Lead_Inbound_Log__c` has 5 rows but only 1 with `Status__c='written'` and 4 with `Status__c='received'` then `Status__c='replayed_duplicate'` |
| L-5 | Round-robin distribution over 100 leads | Replay 100 Path A4b fixtures, all with `formattedRegion='North America'` (default region) | OwnerId distribution: 100% Katie.UAT (since the switch maps to a single AssignmentID) — confirms current Zap behavior; n8n migration parity. *(Round-robin across multiple AEs is a Phase 2 enhancement, not parity)* |
| L-6 | Pre-Discovery long-running task | Trigger 10 Pre-Discovery webhooks back-to-back | All complete within 120s each; queue handles concurrency; no SF Update collisions on the same Contact |

### 15.7 UAT Sign-off Gates (3 gates, sequential)

Each gate requires written approval (Slack ✅ in the gate channel from each owner is acceptable).

#### Gate 1 — Code Review (after Day 5)

Required reviewers:
- **n8n developer (peer review):** confirms workflow JSON is well-named, sub-workflows are properly versioned, no inline secrets, error workflow attached to all receivers
- **SF Admin:** confirms all SOQL in code nodes is parameterized (no injection), all SF actions have correct field maps per §7, integration user profile has FLS access to every field written
- **RevOps lead (Kirk):** confirms scope matches the 7-zap inventory and no critical fields are dropped

Gate 1 passes when all three review checklists are signed and the workflows are deployed to UAT n8n.

#### Gate 2 — Functional UAT (after Day 6 morning)

Required artifacts:
- C-1 to C-16 component test results (each with pre/post SOQL outputs in a Google Sheet)
- T1-T25 integration test results
- L-1 to L-6 performance test results
- `Lead_Inbound_Log__c` audit query showing 0 unintentional `Status__c='failed'` rows during the test session
- Daily report fixture run showing the UAT report Slack message looks correct

Required reviewers:
- **SF Admin:** signs that all SF assertions match expected
- **Sales Ops:** signs that AE routing matches today's Zapier behavior (or documents intentional changes)
- **Marketing Ops:** signs that UTM/click ID fields are captured correctly per the spec
- **RevOps lead (Kirk):** final sign-off

Gate 2 passes when all four reviewers approve. Then proceed to Day 6 afternoon Phase A enable.

#### Gate 3 — Parity Gate (after first 72h of parallel-run)

Run during the first 72h of the production parallel-run (Phase A Stage 1 in prod). Daily check at 9am Central:

```sql
-- Run on por-prod. Compares Zapier-received counts vs n8n-received counts per form, last 24 hr.
SELECT Source__c,
       COUNT_DISTINCT(External_Submission_Id__c) AS total_unique,
       SUM(CASE WHEN n8n_Execution_Id__c != NULL THEN 1 ELSE 0 END) AS n8n_received,
       SUM(CASE WHEN n8n_Execution_Id__c = NULL THEN 1 ELSE 0 END) AS zapier_only
FROM Lead_Inbound_Log__c
WHERE Received_At__c = LAST_N_DAYS:1
GROUP BY Source__c
```

Pass criteria for Gate 3:
- For 3 consecutive days: `n8n_received / total_unique >= 99.9%` per source
- `zapier_only` count ≤ 0.1% per source (i.e., n8n received everything Zapier did)
- Reconciliation cron `replayed` count = 0 (i.e., real-time delivery is working — reconciliation is just a safety net)
- Zero `Status__c='failed'` rows in n8n's executions

Required reviewers: same as Gate 2 + **SDR Manager** (because they actually feel the impact of missed leads). Gate 3 passes → continue parallel-run to Day 14 (Phase A Stages 2 + 3); does NOT yet authorize Phase B.

#### Gate 4 — Lead-Capture Sign-off (after Day 14 of parallel-run, REQUIRED for Phase B)

**New gate, sits between Gate 3 (Parity 99.9%) and Phase B (Zapier-off).** Required for Phase B to proceed. The runbook owner runs this gate against the artifacts produced during the 14-day parallel-run window.

Pass criteria — ALL must be met:

- 14 consecutive days of green daily standup verdicts in `#r360-leads-daily`
- 0 SDR/AE-reported missed leads in `#r360-leads-parallel-run`
- `runbooks/scripts/audit-lead-capture.sh` final report shows **100% capture** (every Zapier task → either `Lead_Inbound_Log__c` row OR a SF Lead/Contact)
- Hourly reconciliation cron `|A - B| = 0` for all 14 days (no Zapier-received-but-n8n-missed entries)
- Reconciliation cron `replayed` count from §13.2 = 0 (real-time delivery is bulletproof; reconciliation is just safety)
- WP DB poll cron has fired ≥1× per 10-min window for the full 14 days (no missed reconciliation cycles)
- 0 P0 incidents (Zapier task fired but neither system wrote) in the 14-day window
- All Pre-Discovery webhooks (T23 in §17.5) completed within 280s p95

Required sign-offs (all six must approve):
- **SF Admin**
- **Sales Ops**
- **Marketing Ops**
- **RevOps lead (Kirk)**
- **SDR Manager** *(newly required — they're the consumers of R360 leads)*
- **AM Manager** *(newly required — they pick up Customer-bucket Contact updates)*

Acceptable sign-off mechanism: Slack ✅ in the gate channel from each owner, archived to `migration-plans/uat-results/parallel-run-final-{date}.md`.

If ANY criterion fails on Day 14:
- Extend parallel-run by another 7 days
- Re-run the audit at Day 21
- If still failing on Day 21: escalate scope re-evaluation to stakeholders (Kirk + Sales/Marketing leadership)

Gate 4 passes → proceed to Phase B (staged decommission per §18). The full operational protocol is in `deliverables/r360-n8n-migration/runbooks/parallel-run-validation.md` §7.

### 15.8 Production UAT — Phase A Dual-Write Daily Procedure

For 72 hours after Phase A enable, run this checklist daily at 9am Central:

```bash
# 1. Pull last-24h delivery comparison
sf data query -q "
  SELECT Source__c,
         COUNT_DISTINCT(External_Submission_Id__c) AS total_unique,
         SUM(CASE WHEN n8n_Execution_Id__c != NULL THEN 1 ELSE 0 END) AS n8n_received
  FROM Lead_Inbound_Log__c
  WHERE Received_At__c = LAST_N_DAYS:1
  GROUP BY Source__c
" --target-org por-prod

# 2. Pull n8n failure rows
sf data query -q "
  SELECT Id, Source__c, Status__c, Error_Message__c, Retry_Count__c, Received_At__c
  FROM Lead_Inbound_Log__c
  WHERE Status__c = 'failed' AND Received_At__c = LAST_N_DAYS:1
" --target-org por-prod

# 3. Pull divergent Zapier-only entries (where n8n didn't receive)
sf data query -q "
  SELECT Id, Source__c, External_Submission_Id__c, Received_At__c
  FROM Lead_Inbound_Log__c
  WHERE n8n_Execution_Id__c = NULL AND Received_At__c = LAST_N_DAYS:1
" --target-org por-prod

# 4. Compare to Zapier task history (manual: Zapier UI → Tasks → filter by Zap → last 24h)

# 5. Post results to #r360-leads-daily Slack with verdict: PASS / DRIFT / FAIL
```

If any divergence found, **do NOT advance to Gate 3**. Investigate:
- WPForms-Webhook addon misconfigured?
- n8n receiver rejected a payload (check n8n execution logs)?
- Race condition on `Lead_Inbound_Log__c` upsert?

### 15.9 UAT Rollback Criteria

The migration rolls back to "Zapier on, n8n off" if ANY of the following occur during UAT or Phase A:

| Trigger | Action |
|---|---|
| Gate 2 component tests show > 1 false-positive write (e.g., Path A creates a Lead when it should have updated) | Stop. Fix in n8n. Re-run Gate 2 from scratch. |
| Phase A 24-hour parity < 95% per source | Disable n8n receivers for that source. Investigate. Zapier still firing → no leads lost. |
| Real-time webhook drops detected by SDR/AE flag in `#r360-leads-parallel-run` (since reconciliation cron is deferred — only sales feedback catches webhook drops in v1) | Stop. Investigate WPForms-Webhook addon config. Re-enable Zapier on affected feeder. Disable Phase B until resolved. |
| `Lead_Inbound_Log__c.Status__c='failed'` rate > 5% | Disable n8n receivers. Zapier remains primary. |
| Plauti DupCheck blocks > 0 writes that Zapier currently makes | Verify FLS on `dupcheck__dc3DisableDuplicateCheck__c` for integration user. Fix; re-test. |
| Salesforce daily API limit hit | Implement bulk batching in receivers; re-test load. |

After rollback, fix the root cause and re-enter Phase A. Total fix-and-replay should not exceed 1 week or the migration scope/timeline should be re-evaluated with stakeholders.

### 15.10 UAT artifacts to retain

After successful migration, store these in `migration-plans/uat-results/` (NOT checked into git — sensitive data):
- C-1 to C-16 component test result spreadsheet
- T1-T25 integration test result spreadsheet
- L-1 to L-6 performance test result graphs
- 3 daily Phase A parity reports (Slack screenshots or exports)
- Final SF audit query results
- Sign-off Slack threads (or email approvals)

---

## 18. Cutover (R360-only)

> **This section is a summary. The operational protocol — daily checklists, hourly reconciliation cron, sales-team feedback loop, Gate 4 sign-off, staged decommission, and 30-day enhanced monitoring — lives in `deliverables/r360-n8n-migration/runbooks/parallel-run-validation.md`.** The runbook is a first-class deliverable for the parallel-run window; this section is the build-plan-side index.

### Phase A — Production parallel-run (T-0 to T+14d, staged 14-day protocol)

**Replaces the prior plan's 72h dual-write footnote.** The user requirement was explicit: "I need this in production in parallel with Zapier, then validation everything is running smooth and getting all leads (as part of the plan)." A 72h window cannot prove that.

For each of the 4 main R360 feeders, configure the source to fire BOTH:
- The existing WPForms-Zapier addon (continues to fire Zaps 316698017 / 316701470 / 316797350 → central 316797554) and the existing SocialIntents bot Zap (332679789 Path K)
- The new WPForms-Webhook addon / SocialIntents direct webhook pointing to n8n

Both systems are idempotent (same `Idempotency_Hash__c`) — first write to SF wins, the other short-circuits.

**Stage breakdown:**

| Stage | Window | Activity | Cadence |
|---|---|---|---|
| Quiet observation | T+0 to T+72h | n8n receivers enabled. Daily 9am SOQL audit (§17.8). Catch Day-1 surprises (auth, FLS, schema drift). | Daily |
| Active comparison | T+72h to T+7d | Hourly Zapier-vs-n8n reconciliation cron (`cron/r360-parallel-run-reconciliation.json`). SDR/AE feedback channel `#r360-leads-parallel-run` opened. | Hourly + daily standup |
| Confidence-build | T+7d to T+14d | Continue automated reconciliation. Sales team explicitly asked at standup: "any missed R360 leads?" | Daily |

**Gate 4 (Lead-Capture Sign-off)** must pass before Phase B begins. See §17.7.

**Operational artifacts (in the runbook):**
- §3 — Hourly Zapier-vs-n8n reconciliation cron (set difference math)
- §4 — `runbooks/scripts/audit-lead-capture.sh` (cross-system lead-capture proof)
- §5 — `#r360-leads-parallel-run` Slack channel + `/missed-lead {email}` triage bot
- §6 — Daily standup green/yellow/red template
- §10 — P0/P1/P2 failure response playbook

### Phase B — Staged Zapier decommission (T+15d to T+20d, NOT a single Sunday cutover)

**Replaces the prior plan's "single Sunday morning" cutover.** Stage decommission so any post-cutover regression isolates to one feeder, with automatic re-enable safety nets.

| Day | Disable | Monitoring window | Auto re-enable trigger |
|---|---|---|---|
| Day 15 | **316698017** (Watch Video) | 24h | n8n received-rate < 99.9% for any 4h window → re-enable |
| Day 16 | **316701470** (Get a Demo) | 24h | same |
| Day 17 | **316797350** (Contact Form) | 24h | same |
| Day 18 | **332679789 Path K** (Bot R360 — Path J POR stays) | 24h | same |
| Day 19 | **316797554** (central processor) | 24h | same |
| Day 20 | **336544812** (R360 Pre-Discovery) + **225753704** (R360 FAQ) | 48h | same |

**Reactivation safety net:** during each monitoring window, the audit-lead-capture script runs every 4 hours instead of nightly. If `n8n received-rate < 99.9%` for any 4h window, IMMEDIATELY re-enable the most-recently-disabled Zap and pause decommission. Investigate before resuming.

### Phase C — Post-Phase-B 30-day enhanced monitoring (T+21d to T+60d)

| Window | Audit cadence | Verdict channel |
|---|---|---|
| T+21d to T+30d | Daily 9am audit (lead-capture script) | `#r360-leads-daily` |
| T+31d to T+45d | Every-other-day audit | `#r360-leads-daily` |
| T+46d to T+60d | Weekly audit | `#r360-leads-daily` |
| T+60d | Final all-clear announcement to RevOps + Sales leadership; archive parallel-run artifacts to `migration-plans/uat-results/` | one-time |

Also at T+21d: cleanup tasks
- Delete the WPForms-Zapier addon entries for the R360 forms in WordPress.
- Archive the 7 R360 Zaps in Zapier (don't delete — recovery option for 90 days).
- Update internal docs and runbook references to point to n8n.

### Rollback

If Phase B reveals a critical issue:
- Turn the affected Zap back ON.
- n8n receivers continue running — they short-circuit on idempotency hash, so no double write.
- Investigate, fix, redo Phase B.

If something is fundamentally broken in n8n:
- Turn ALL 7 Zaps back on.
- Disable n8n R360 receivers (point load balancer to 503).
- Reset to Phase A indefinitely.

**Total operational effort during 60-day cutover window: ~34 hours of RevOps time** (per `runbooks/parallel-run-validation.md` §10 effort table). Cheap insurance vs. one missed enterprise R360 deal.

---

## 19. Risks & Open Questions

| Risk / Question | Owner | Resolution |
|---|---|---|
| WordPress DB read-only credentials for n8n reconciliation | Web team | Day 1 task. If unavailable, fall back to native `wp_options`-based polling or ask Web to expose. |
| Live Zapier catch URL for `/utwbkbm/` not in export | Kirk | Day 1 task — copy from each Zap's trigger config in Zapier UI |
| 15-min delay on Watch Video and Get a Demo routers — preserve or drop? | Marketing | Confirm intentional (Pardot enrichment lag) or accidental. Default: replicate via n8n Wait node, note as "configurable" |
| 22 R360 SF IDs from §11 — still active in prod and present in UAT? | SF Admin | Day 1 task — run validation SOQL |
| `User.Slack_ID__c` populated for all R360 AEs (Josh, Dean, Katie)? | SF Admin | `SELECT Id, Name, Slack_ID__c FROM User WHERE Id IN ('0050L000008hH5DQAU', '0050L000008uAHvQAM', '0054u0000094ck7AAA')` |
| SOQL injection in `Create Queries` (raw string interpolation) | n8n developer | Fix applied in §6.3 — verify on day 2 |
| Two SF auth credentials in central processor today | SF Admin | Pick one integration user; ensure profile permissions cover Lead/Contact/Account/Case/CampaignMember writes |
| R360 marketing campaign ID for `add_lead_to_campaign` | Marketing Ops | `701Ki000000cMwkIAE` from §11 — confirm still active |
| WPForms-Webhook addon vs native n8n WPForms Trigger node | Web team | Both work; native trigger recommended (less WordPress-side config) |
| `Bernice Smith` AssignmentID dead code in Africa region | Marketing Ops | Confirm fallback to Katie is OK (probably is — comment dates from a personnel change) |
| Slack channels for `#r360-leads-errors` and `#r360-leads-daily` | RevOps | Pick or create. Get bot invited |
| Pre-Discovery webhook timeout (Perplexity 60-120s + GPT 30-60s) | n8n developer | Use async pattern — return 200 immediately, queue the long-running work |

---

## 20. File Manifest

What this delivery contains:

```
migration-plans/
├── n8n-lead-inbound-migration-plan.md    (broader 19-zap plan, 891 lines — reference only)
├── r360-n8n-build-plan.md                ← THIS FILE — the focused R360 build playbook (verified, UAT-baked)
├── uat-results/                          ← created during UAT runs (gitignored)
└── specs/
    ├── spec_316797554.md                  ← R360 deep spec (1,118 lines) — implementation reference
    ├── spec_book_a_demo_cpq.md            (POR — out of scope for this rescope)
    ├── spec_contact_sales_short_form.md   (POR — out of scope)
    ├── spec_bot_book_a_demo.md            ← R360 branch (Path K) — Phase 1B reference
    ├── spec_pre_discovery_ai_notes.md     ← R360 Pre-Discovery — Phase 1B reference
    └── spec_satellites.md                 (mentions 3 R360 router specs in detail)
```

**For the build:** read this plan top-to-bottom, then drill into `specs/spec_316797554.md` for any node where §7's field map is incomplete (e.g., Case create, Campaign Member updates, Slack/Email message templates).

---

**End of R360 build plan.** Estimated effort: **7 days of focused engineering + 72-hour dual-write soak + 14-day post-cutover monitoring** before declaring success. The plan + the 1,118-line deep spec + 5 supporting spec docs (~5,500 lines total) constitute the single source of truth the build team executes against.

---

## 21. POR Shadow Framework (UAT shadow live; prod partial as of 2026-05-19)

This section documents the parallel POR (point-of-rental.com) shadow implementation that was built alongside the R360 migration. POR forms route through a separate receiver/resolver/writer chain, isolated from R360 at every node. The Plauti-fallback pattern (§15.A) is deployed in both writers.

### 21.1 — POR Forms in Scope (v1.0)

| Form ID | WPForm Name | Volume (lifetime) | Receiver endpoint | n8n Workflow ID |
|---|---|---|---|---|
| 64681 | POR Contact Us (dual EU/non-EU routing via Region field 17) | 5,150 entries | `/por/contact-us-64681` | `vikLO2gC6jqSJLQA` |
| 64783 | POR Customer Contact | 33 entries | `/por/customer-contact-64783` | `10hC9N1FM4IeQwOc` |
| n/a | SocialIntents Bot (personas: Penny Pointer / Penny) | n/a | `/por/bot` | `SLXJapuzXLUTk5Cw` |

**Sunsetted — NOT wired in n8n:** forms 51987 and 53115. Naturally ignored; Marketing confirmed no action needed.

**Out-of-scope pending Marketing inventory:** forms 52153, 61711, 52760, 43036, 103125, 48887, and several smaller forms. Marketing input required before these are added to scope.

### 21.2 — POR Field Map (form 64681)

POR's field-ID assignments differ from R360. R360 uses field IDs 2/3/5/13 for first/last/company/email; POR uses a different layout:

| Field ID | Semantic | Notes |
|---|---|---|
| 1 | First Name | |
| 5 | Last Name | |
| 2 | Company Name | |
| 3 | Email | |
| 25 | Phone | |
| 17 | Region | Drives EU vs non-EU branch — value tested with `formattedRegion.toLowerCase().includes('europe')` |
| 26 | URL (landing page) | Maps to `pi__url__c` |
| 20–22, 27–28, 45–46 | UTM fields + keyword + gadid | Normalized to `utm_*` / `pi__utm_*` |
| 39–40 | CRO1, CRO2 | |
| 41–44 | gclid, fbc, fbp, msclkid | EU path only — non-EU forms omit these fields entirely |
| 18 | Current Customer checkbox | form 64783 only |
| 16 | Preferred Contact | form 64783 only |

**Defensive field shape handling:** the receiver field-map reads both the nested WPForms object shape (`fields.17.value`) and the flat shape (`fields.17`) so that both WPForms webhook formats are accepted without a normalization failure.

### 21.3 — POR Resolver

**Workflow:** `qxZp8GqN8i0b4fuz` (name: "POR Sub: Resolver"). Cloned from the R360 resolver (`sub-r360-resolver`) with two POR-specific overrides.

#### Assignment Owner — 4-region mapping

| Region | Queue ID | AE ID | Notification Email(s) | Business Hours ID | Lead Account ID |
|---|---|---|---|---|---|
| Australia / Asia | `00G0L000004WbECUA0` | `0050L000008hH5DQAU` (Josh O'Connell) | `josh.oconnell@pointofrental.com`, `kayla.oloughlin@pointofrental.com` | `01m0L00000001OZQAY` | `001Ki000009wWMPIA2` |
| Africa | `00G4u000004AmQJEA0` | `0050L000008uAHvQAM` (Dean Hammond) | `dean.hammond@pointofrental.com` | `01m0L00000001PcQAI` | `001Ki000009wWM0IAM` |
| Europe | `00G0L000004WbEDUA0` | `0054u000008m3w6AAA` (Marcus Sutton) | `marcus.sutton@pointofrental.com`, `uksdr@pointofrental.com` | `01m0L00000001PcQAI` | `001Ki000009wWM0IAM` |
| North America / South America / default | `00G0L000004WbEEUA0` | `0054u000008m009AAA` (Hunter Ellison / Katie McFarland NA) | `katie.mcfarland@pointofrental.com`, `hunter.ellison@pointofrental.com` | `01m0h0000005HbeAAE` | `001Ki000009wWMPIA2` |

#### Decide-path logic

```
isPORForm = WPFormName IN ['POR_ContactUs', 'POR_CustomerContact', 'POR_Bot']
isEU      = formattedRegion.toLowerCase().includes('europe')
```

Decision paths emitted:

| Path code | Condition | Action |
|---|---|---|
| `X_already_matched` | Both Lead AND Contact found | Skip — no write needed |
| `B` | Lead found (not converted) | Update existing Lead |
| `C` | Contact found under a Customer Account | Update Contact (AM ownership preserved) + create Case |
| `D` | Contact found under a non-Customer Account | Update Contact (SDR reassign) + add CampaignMember |
| `A4b` | No record found | Create new Lead |

**Notable difference from R360:** POR does NOT have an `X_no_record_skipped_contactform` rule. The R360 Contact Form skips creation when no record exists (per §5.4); POR Contact Us always falls through to A4b and creates a Lead.

**Click ID passthrough (FU-1, deployed 2026-05-19):** The resolver's Decide-path output now propagates `gclid`, `fbc`, `fbp`, and `msclkid` from the original webhook input through to the writer payload. Required for EU lead bodies — non-EU paths don't write these fields.

### 21.4 — POR Writer

**Workflow:** `8bgnoj7dfYg4uqBv` (name: "POR Sub: Writer"). Cloned from R360 writer with POR-specific field values throughout.

#### POR-specific hardcoded IDs

| ID type | POR value | R360 equivalent |
|---|---|---|
| Campaign ID | `7010L00000034Y7QAI` | `701Ki000000cMwkIAE` |
| Lead RecordType (EU only) | `0120L00000098ftQAA` | (R360 does not set RecordType on Lead) |
| Case RecordType | `0124u000000l5qwAAA` | `0124u000000l5qwAAA` (same — shared org RT) |
| Case BusinessHoursId | `01mE0000000HjdIIAS` | differs |

#### Path A4b — Create Lead (no record found)

Lead body includes: `LastName`, `FirstName`, `Company`, `Email`, `Phone`, `Country`, `LeadSource='Web'`, `Status='Cold / Not Started'`, `OwnerId` (AssignmentID), `MQL__c=true`, `POR_Record__c=true`, `HasOptedOutOfEmail=false`, `Personal_Auto_Email_Opt_Out__c=false`, `Most_Recent_Pardot_Form__c='Book A Demo Form'`, `Date_Of_Most_Recent_Pardot_Form__c` (today), `Queue_Region__c`, `Assigned_SDR__c`, `Reassign_Lead_Using_Assignment_Rules__c=true`, `dupcheck__dc3DisableDuplicateCheck__c=true`, `CRO1__c`, `CRO2__c`, `pi__url__c`, `utm_*`, `pi__utm_*`, `Sales_Notes__c`, `pi__notes__c`, `Discovery_Notes__c`, `Description`.

EU additions: `RecordTypeId='0120L00000098ftQAA'` + `gclid__c`, `fbc__c`, `fbp__c`, `msclkid__c`.

Plauti-fallback (§15.A) applies here — if Create Lead returns the Plauti dup error, the fallback chain fires, finds the existing Lead by exact email, and updates it as a Path B.

#### Path B — Update existing Lead

Body: `Email`, `Phone`, `Status='Cold / Not Started'`, `LeadSource='Web'`, `MQL__c=true`, `POR_Record__c=true`, `Assigned_SDR__c`, `OwnerId`, `Most_Recent_Pardot_Form__c='Book A Demo'`, `Date_Of_Most_Recent_Pardot_Form__c` (today), `Queue_Region__c`, `CRO1__c`, `CRO2__c`, `pi__url__c`, `utm_*`, `pi__utm_*`, `Sales_Notes__c`, `pi__notes__c`, `HasOptedOutOfEmail=false`, `Personal_Auto_Email_Opt_Out__c=false`.

EU additions: `RecordTypeId` + click IDs (`gclid__c`, `fbc__c`, `fbp__c`, `msclkid__c`).

#### Path C — Update Contact (Customer / AM)

Body: `LastName`, `FirstName`, `Phone`, `Status__c='Cold / Not Started'`, `LeadSource='Web'`, `POR_Record__c=true`, `dupcheck__dc3DisableDuplicateCheck__c=true`, `Most_Recent_Pardot_Form__c='Book a Demo'` (lowercase 'a' — differs from Path B/D), `Queue_Region__c`, `CRO1__c`, `CRO2__c`, `pi__url__c`, `pi__utm_*`, `Sales_Notes__c`, `Inside_Lead_Sales_Notes__c`, `pi__notes__c`, `Description`, `HasOptedOutOfEmail=false`.

**AM path does NOT set `MQL__c`, `Assigned_SDR__c`, or `OwnerId`** — existing AM ownership is preserved.

Then: Case create. `Subject = '{region} - Book a Demo - Sales Form Fill'`, `Origin='Web'`, `Status='New'`, `Priority='Medium'`, `SuppliedName/Email/Phone/Company`, `OwnerId` (EU hardcoded to `00G0L000004WbEDUA0`; non-EU dynamic `InsideSalesQueue`), `Campaign__c='7010L00000034Y7QAI'`, `UTM_*`.

Case create uses `onError: continueRegularOutput` (deployed 2026-05-19). Reason: the UAT org's RTFL Case After Trigger blocks Case creates for unverified email domains. Production has verified domain so this only surfaces in UAT shadow testing.

#### Path D — Update Contact (SDR / Prospect)

Body: `LastName`, `FirstName`, `Phone`, `Email`, `Status__c='Cold / Not Started'`, `LeadSource='Web'`, `MQL__c=true` (SDR path DOES set MQL, unlike AM), `POR_Record__c=true`, `dupcheck__dc3DisableDuplicateCheck__c=true`, `OwnerId` (reassign to SDR queue), `Assigned_SDR__c`, `Lead_Owner__c`, `Most_Recent_Pardot_Form__c='Book A Demo Form'`, `Date_Of_Most_Recent_Pardot_Form__c`, `Queue_Region__c`, `CRO1__c`, `CRO2__c`, `pi__url__c`, `pi__utm_*`, `Sales_Notes__c`, `Inside_Lead_Sales_Notes__c`, `pi__notes__c`, `Description`, `HasOptedOutOfEmail=false`.

No Case created on the SDR path. CampaignMember add only.

#### Plauti-fallback chain (FU-2 + Item 2, deployed 2026-05-18/19)

See §15.A for the full pattern spec. In the POR writer specifically: when Path A4b's Create Lead fails with a Plauti dup error, the fallback chain queries by exact email, builds a Path-B-style update body, patches the existing Lead, and merges back into the CampaignMember step. `Code: Build final-update payload` reads `leadId` from `$('Code: Build Lead update body (Plauti-recovery)').first()?.json?.leadId` and re-labels `Decision_Path__c` from `A4b` to `B`.

### 21.5 — POR DB Reconciliation Cron

**Workflow:** `tza5WF0jMA8VLia0`. Runs every 10 minutes.

1. SSH to POR WPE install — credential ID `2FG7uSHOHb43CNMt`, host `por@por.ssh.wpengine.net`.
2. Execute via SSH:
   ```sql
   MYSQL_PWD=J1eW2ZVvbt1hZ9zN mysql -h 127.0.0.1 -P 3306 -u por wp_por \
     -e "SELECT ... FROM wp_wpforms_entries
         WHERE form_id IN (64681, 64783)
         AND date >= NOW() - INTERVAL 30 MINUTE"
   ```
3. Parse TSV output → compute `Idempotency_Hash__c` per entry (same hashing logic as R360 cron).
4. SOQL: `SELECT Idempotency_Hash__c FROM Lead_Inbound_Log__c WHERE Idempotency_Hash__c IN (...)` → diff missing hashes.
5. Replay each missing entry to the appropriate per-form receiver: `/por/contact-us-64681` or `/por/customer-contact-64783`.

This is a direct mirror of the R360 reconciliation cron (`T1XKVSPaLzAuUh0l`) targeting the `wp_por` database on the POR WPE install instead of the R360 install.

### 21.6 — POR Salesforce Picklist Values

`Lead_Inbound_Log__c.Source__c` picklist values added — deployed to both UAT and PROD:

| API value | Label |
|---|---|
| `wpform_64681` | POR Contact Us |
| `wpform_64783` | POR Customer Contact |
| `bot_por` | SocialIntents Bot POR Path |

`R360_n8n_Integration` permission set assigned to POR Integration user (`0050L00000822fcQAA`) in PROD to grant FLS on all `Lead_Inbound_Log__c` fields.

### 21.7 — Known POR Design Compromises

**1. Subscription proxy for C/D path distinction.** POR Path C vs D routing uses `Account.Status__c = 'Customer'` to determine AM vs SDR ownership — mirroring the R360 resolver logic that was already in place. The original POR Zap used an SBQQ query (`SBQQ__Subscription__c WHERE StartDate <= TODAY AND EndDate >= TODAY`) plus an `EU Line_Total__c > 1` filter. Neither is implemented in v1.0. Estimated 5–10 % potential misroute for accounts whose `Status__c` field is stale relative to active subscription state. Flagged for v1.1 remediation.

**2. Auto-acknowledgment email not ported.** The original Zap sends an acknowledgment from `no-reply@pointofrental.com` with subject "Acknowledgment & Next Steps" after every submission. v1.0 relies on WPForms native confirmation email or AE manual follow-up. Tabled — requires Marketing approval on new template content.

**3. ReQuery sub-tree not ported.** The original Zap includes a 15-second wait + secondary find logic for the no-record-found case. The Plauti-fallback pattern (§15.A) covers the main edge case that the ReQuery was designed to handle (record created milliseconds before the submission, visible to a second lookup but not the first). Functional parity is estimated at ~95 %; the remaining 5 % (true timing races) will surface as A4b Leads that could have been updates — low severity.

**4. POR sub-notify templates pending.** The POR writer emits `template = 'lead_created_por' | 'lead_updated_por' | 'contact_AM_por' | 'contact_SDR_por'` in its output but the shared `sub-notify` workflow does not yet have Switch rules for these values. POR Lead and Contact writes currently succeed silently — no Slack DM or Gmail notification is sent. Tabled scope item; does not affect Lead/Contact/Case data integrity.

---

**End of POR Shadow Framework section.** POR v1.0 scope: forms 64681, 64783, and the SocialIntents Bot POR path. Forms 51987 and 53115 sunsetted. 10+ additional forms pending Marketing inventory for v1.1 scoping.
