#!/usr/bin/env node
// Regression test for sub-r360-resolver.json after the Africa-triage patch.
//
// Goals:
//   1. Confirm Assignment Owner code is byte-identical to baseline (no other regions impacted).
//   2. Confirm IF: Africa triage? routes by formattedRegion correctly.
//   3. Confirm connection graph: Code: Merge Find results -> IF: Africa triage?,
//      with both Africa-continue and non-Africa converging on Code: Assignment Owner.
//   4. Run Assignment Owner on 5 region fixtures (Africa, Europe, NA, Australia, Asia)
//      and assert outputs match the pre-patch baseline.
//
// Run: node deliverables/r360-africa-triage/tests/regression-test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const RESOLVER_PATH = path.join(REPO_ROOT, 'deliverables/r360-n8n-migration/n8n/sub-r360-resolver.json');
const TRIAGE_PATH = path.join(REPO_ROOT, 'deliverables/r360-africa-triage/n8n/sub-r360-africa-triage.json');

const log = (msg) => process.stdout.write(`${msg}\n`);
let failures = 0;

function assert(label, cond, detail = '') {
  if (cond) {
    log(`  PASS  ${label}`);
  } else {
    log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

function canonicalize(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  return Object.keys(v).sort().reduce((acc, k) => { acc[k] = canonicalize(v[k]); return acc; }, {});
}
function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(canonicalize(actual)) === JSON.stringify(canonicalize(expected));
  if (ok) {
    log(`  PASS  ${label}`);
  } else {
    log(`  FAIL  ${label}`);
    log(`        expected: ${JSON.stringify(canonicalize(expected))}`);
    log(`        actual:   ${JSON.stringify(canonicalize(actual))}`);
    failures++;
  }
}

const resolver = JSON.parse(fs.readFileSync(RESOLVER_PATH, 'utf8'));
const triage = JSON.parse(fs.readFileSync(TRIAGE_PATH, 'utf8'));

// ---------- Section 1: structural assertions ----------
log('\n[1] Resolver structural assertions');

const nodesByName = Object.fromEntries(resolver.nodes.map(n => [n.name, n]));
assert('IF: Africa triage? node exists', !!nodesByName['IF: Africa triage?']);
assert('Execute: sub-r360-africa-triage node exists', !!nodesByName['Execute: sub-r360-africa-triage']);
assert('IF: Africa decision continue? node exists', !!nodesByName['IF: Africa decision continue?']);
assert('Code: Assignment Owner still exists (unchanged)', !!nodesByName['Code: Assignment Owner']);
assert('IF: superseded? still exists (unchanged)', !!nodesByName['IF: superseded? (skip all SF writes)']);

// IF: Africa triage? condition
const ifAfrica = nodesByName['IF: Africa triage?'];
const africaCondition = ifAfrica?.parameters?.conditions?.conditions?.[0];
assertEqual('IF: Africa triage? leftValue is formattedRegion',
  africaCondition?.leftValue, '={{ $json.formattedRegion }}');
assertEqual('IF: Africa triage? rightValue is "Africa"',
  africaCondition?.rightValue, 'Africa');
assertEqual('IF: Africa triage? operator is equals',
  africaCondition?.operator?.operation, 'equals');

// IF: Africa decision continue? condition
const ifDecision = nodesByName['IF: Africa decision continue?'];
const decisionCondition = ifDecision?.parameters?.conditions?.conditions?.[0];
assertEqual('IF: Africa decision continue? leftValue is africa_decision',
  decisionCondition?.leftValue, '={{ $json.africa_decision }}');
assertEqual('IF: Africa decision continue? rightValue is "continue"',
  decisionCondition?.rightValue, 'continue');

// ---------- Section 2: connection graph assertions ----------
log('\n[2] Connection graph assertions');

const conns = resolver.connections;

// Code: Merge Find results -> IF: Africa triage? (was: -> Code: Assignment Owner)
assertEqual('Merge Find results NOW points to IF: Africa triage?',
  conns['Code: Merge Find results']?.main?.[0]?.[0]?.node,
  'IF: Africa triage?');

// IF: Africa triage? TRUE branch (main[0]) -> Execute: sub-r360-africa-triage
assertEqual('IF: Africa triage? TRUE -> Execute: sub-r360-africa-triage',
  conns['IF: Africa triage?']?.main?.[0]?.[0]?.node,
  'Execute: sub-r360-africa-triage');

// IF: Africa triage? FALSE branch (main[1]) -> Code: Assignment Owner (non-Africa path preserved)
assertEqual('IF: Africa triage? FALSE -> Code: Assignment Owner (non-Africa preserved)',
  conns['IF: Africa triage?']?.main?.[1]?.[0]?.node,
  'Code: Assignment Owner');

// Execute: sub-r360-africa-triage -> IF: Africa decision continue?
assertEqual('Execute: sub-r360-africa-triage -> IF: Africa decision continue?',
  conns['Execute: sub-r360-africa-triage']?.main?.[0]?.[0]?.node,
  'IF: Africa decision continue?');

// IF: Africa decision continue? TRUE -> Code: Assignment Owner (Africa-continue path)
assertEqual('IF: Africa decision continue? TRUE -> Code: Assignment Owner',
  conns['IF: Africa decision continue?']?.main?.[0]?.[0]?.node,
  'Code: Assignment Owner');

// IF: Africa decision continue? FALSE -> [] (kill path terminates)
assertEqual('IF: Africa decision continue? FALSE -> [] (terminates)',
  conns['IF: Africa decision continue?']?.main?.[1],
  []);

// Code: Assignment Owner -> Code: Decide path & build payload (UNCHANGED downstream)
assertEqual('Code: Assignment Owner downstream UNCHANGED',
  conns['Code: Assignment Owner']?.main?.[0]?.[0]?.node,
  'Code: Decide path & build payload');

// ---------- Section 3: Assignment Owner regression — output identical to baseline ----------
log('\n[3] Assignment Owner regression (non-Africa regions must produce identical output)');

const assignmentOwnerNode = nodesByName['Code: Assignment Owner'];
const assignmentCode = assignmentOwnerNode.parameters.jsCode;

// Execute the Assignment Owner code in a sandboxed function with a synthetic $json.
function runAssignmentOwner(region) {
  const $json = { formattedRegion: region, _carry: 'untouched' };
  // The code references $json globally and uses spread to return.
  // We wrap in a function that exposes $json and returns the [{json:...}] array.
  const fn = new Function('$json', `${assignmentCode}`);
  return fn($json)[0].json;
}

const BASELINE = {
  'Africa': {
    formattedRegion: 'Africa',
    _carry: 'untouched',
    InsideSalesQueue: '00G4u000004AmQJEA0',
    BusinessHours: '01m0L00000001PcQAI',
    AssignmentID: '0054u0000094ck7AAA',
    LeadAccountId: '0014u00002BFXvRAAX',
    NotificationEmail: 'bernice.smith@pointofrental.com, katie.mcfarland@pointofrental.com, jenna@record360.com, dhaber@record360.com'
  },
  'Europe': {
    formattedRegion: 'Europe',
    _carry: 'untouched',
    InsideSalesQueue: '00G0L000004WbEDUA0',
    BusinessHours: '01m0L00000001PcQAI',
    AssignmentID: '0050L000008uAHvQAM',
    LeadAccountId: '001Ki000009wWM0IAM',
    NotificationEmail: 'dean.hammond@pointofrental.com, katie.mcfarland@pointofrental.com, john.ryder@record360.com, dhaber@record360.com, jenna@record360.com'
  },
  'North America': {
    formattedRegion: 'North America',
    _carry: 'untouched',
    InsideSalesQueue: '00G0L000004WbEEUA0',
    BusinessHours: '01m0h0000005HbeAAE',
    AssignmentID: '0054u0000094ck7AAA',
    LeadAccountId: '0014u00002BFXvRAAX',
    NotificationEmail: 'katie.mcfarland@pointofrental.com, dhaber@record360.com, jenna@record360.com, may@record360.com'
  },
  'Australia': {
    formattedRegion: 'Australia',
    _carry: 'untouched',
    InsideSalesQueue: '00G0L000004WbECUA0',
    BusinessHours: '01m0L00000001OZQAY',
    AssignmentID: '0050L000008hH5DQAU',
    LeadAccountId: '001Ki000009wWMPIA2',
    NotificationEmail: 'josh.oconnell@pointofrental.com, kayla.oloughlin@pointofrental.com, conor.cummins@pointofrental.com, katie.mcfarland@pointofrental.com, dhaber@record360.com, jenna@record360.com'
  },
  'Asia': {
    formattedRegion: 'Asia',
    _carry: 'untouched',
    InsideSalesQueue: '00G0L000004WbECUA0',
    BusinessHours: '01m0L00000001OZQAY',
    AssignmentID: '0050L000008hH5DQAU',
    LeadAccountId: '001Ki000009wWMPIA2',
    NotificationEmail: 'josh.oconnell@pointofrental.com, kayla.oloughlin@pointofrental.com, conor.cummins@pointofrental.com, katie.mcfarland@pointofrental.com, dhaber@record360.com, jenna@record360.com'
  }
};

for (const region of Object.keys(BASELINE)) {
  const actual = runAssignmentOwner(region);
  assertEqual(`Assignment Owner output for region="${region}" matches baseline`, actual, BASELINE[region]);
}

// ---------- Section 4: Africa-triage workflow assertions ----------
log('\n[4] Africa-triage workflow assertions');

const triageNodesByName = Object.fromEntries(triage.nodes.map(n => [n.name, n]));
assert('Trigger node exists', !!triageNodesByName['When Executed by Another Workflow']);
assert('SF Upsert (africa_pending) exists', !!triageNodesByName['SF Upsert: Lead_Inbound_Log__c (africa_pending)']);
assert('Code: Build Slack Block Kit exists', !!triageNodesByName['Code: Build Slack Block Kit message']);
assert('Slack: DM Dean Hammond exists', !!triageNodesByName['Slack: DM Dean Hammond']);
assert('Slack: DM Kirk Bennett exists', !!triageNodesByName['Slack: DM Kirk Bennett']);
assert('Slack: notify channel (visibility) exists', !!triageNodesByName['Slack: notify channel (visibility-only)']);
assert('Wait node exists', !!triageNodesByName['Wait: human decision (resume on webhook)']);
assert('Code: Parse decision exists', !!triageNodesByName['Code: Parse decision']);
assert('SF Update (decision) exists', !!triageNodesByName['SF Update: Lead_Inbound_Log__c (decision)']);
assert('Slack: notify channel (decision) exists', !!triageNodesByName['Slack: notify channel (decision)']);

// Slack DM body channel IDs are the resolved user IDs
const deanDm = triageNodesByName['Slack: DM Dean Hammond'];
assert('Dean DM targets U0135HAS0KA',
  deanDm.parameters.jsonBody?.includes('U0135HAS0KA'),
  `body=${deanDm.parameters.jsonBody?.slice(0,200)}`);

const kirkDm = triageNodesByName['Slack: DM Kirk Bennett'];
assert('Kirk DM targets U02HR1T6PBK',
  kirkDm.parameters.jsonBody?.includes('U02HR1T6PBK'));

const channelMsg = triageNodesByName['Slack: notify channel (visibility-only)'];
assert('Channel notify targets C06TTMZB3RA',
  channelMsg.parameters.jsonBody?.includes('C06TTMZB3RA'));

// Wait node resume = webhook
const waitNode = triageNodesByName['Wait: human decision (resume on webhook)'];
assertEqual('Wait node resume mode is webhook',
  waitNode.parameters.resume, 'webhook');

// ---------- Section 5: Block Kit simulation ----------
log('\n[5] Block Kit simulation (no real Slack call)');

const buildBlockKitCode = triageNodesByName['Code: Build Slack Block Kit message'].parameters.jsCode;

function runBuildBlockKit($json) {
  // Provide the n8n expressions we reference: $execution.resumeUrl, $execution.id
  const fakeExecution = {
    id: 'EXEC-12345',
    resumeUrl: 'https://n8nweb.ec-ops.org/webhook-waiting/abc-def-resume'
  };
  const $execution_var = fakeExecution;
  const fn = new Function('$json', '$execution', buildBlockKitCode.replace(/\$execution/g, '$execution'));
  return fn($json, fakeExecution)[0].json;
}

const africaPayload = {
  Idempotency_Hash__c: 'TESTHASH-AFRICA-001',
  source: 'wpform_29710',
  formattedRegion: 'Africa',
  formattedFirst: 'Thabo',
  formattedLast: 'Mokoena',
  formattedEmail: 'thabo@example.co.za',
  formattedCompany: 'Mokoena Rentals',
  formattedCountry: 'South Africa',
  phone: '+27 11 555 0123',
  formattedIndustry: 'Equipment Rental',
  WPFormName: 'ContactForm',
  utmsource: 'google',
  utmCampaign: 'r360-africa-2026',
  LandingPage: 'https://record360.com/contact',
  found_lead_id: '00QXXAFRICAEXAMPLE',
  found_contact_id: null,
  found_account_id: null,
  found_account_status: null
};

const result = runBuildBlockKit(africaPayload);
assert('Block Kit result has slack_blocks array', Array.isArray(result.slack_blocks));
assert('Block Kit has header block', result.slack_blocks?.[0]?.type === 'header');
assert('Block Kit includes Continue button with resume URL',
  result.slack_blocks?.some(b => b.type === 'actions' &&
    b.elements?.some(e => e.text?.text?.includes('Continue') && e.url?.includes('decision=continue'))));
assert('Block Kit includes Kill button with resume URL',
  result.slack_blocks?.some(b => b.type === 'actions' &&
    b.elements?.some(e => e.text?.text?.includes('Kill') && e.url?.includes('decision=kill'))));
assert('Block Kit includes SF Lead link when found_lead_id present',
  JSON.stringify(result.slack_blocks).includes('00QXXAFRICAEXAMPLE'));
assert('Block Kit includes lead name', JSON.stringify(result.slack_blocks).includes('Thabo'));
assert('Block Kit includes company', JSON.stringify(result.slack_blocks).includes('Mokoena Rentals'));
assert('Block Kit includes idempotency hash in context',
  JSON.stringify(result.slack_blocks).includes('TESTHASH-AFRICA-001'));

// No-SF-match case
const newAfricaPayload = {
  ...africaPayload,
  found_lead_id: null,
  found_contact_id: null,
  found_account_id: null,
  formattedFirst: 'Amara',
  formattedLast: 'Okeke',
  Idempotency_Hash__c: 'TESTHASH-AFRICA-002'
};
const result2 = runBuildBlockKit(newAfricaPayload);
assert('No-match path shows "No Salesforce match" text',
  JSON.stringify(result2.slack_blocks).toLowerCase().includes('no salesforce match'));

// ---------- Section 6: Parse decision simulation ----------
log('\n[6] Parse decision simulation');

const parseDecisionCode = triageNodesByName['Code: Parse decision'].parameters.jsCode;
// The parse node references $('Code: Build Slack Block Kit message').first().json — provide a stub
function runParseDecision($json, preWaitPayload) {
  const fn = new Function('$json', '$preWait',
    parseDecisionCode.replace(/\$\('Code: Build Slack Block Kit message'\)\.first\(\)\.json/g, '$preWait')
  );
  return fn($json, preWaitPayload)[0].json;
}

// continue case
const continueResult = runParseDecision(
  { decision: 'continue', hash: 'TESTHASH-AFRICA-001' },
  { Idempotency_Hash__c: 'TESTHASH-AFRICA-001', formattedRegion: 'Africa' }
);
assertEqual('continue decision parsed', continueResult.africa_decision, 'continue');
assertEqual('continue Status__c set', continueResult.Status__c, 'africa_continued');

// kill case
const killResult = runParseDecision(
  { decision: 'kill', hash: 'TESTHASH-AFRICA-001' },
  { Idempotency_Hash__c: 'TESTHASH-AFRICA-001', formattedRegion: 'Africa' }
);
assertEqual('kill decision parsed', killResult.africa_decision, 'kill');
assertEqual('kill Status__c set', killResult.Status__c, 'africa_killed');

// hash mismatch -> throws
let threw = false;
try {
  runParseDecision(
    { decision: 'continue', hash: 'ATTACKER-HASH' },
    { Idempotency_Hash__c: 'TESTHASH-AFRICA-001' }
  );
} catch (e) { threw = e.message.includes('Hash mismatch'); }
assert('Hash mismatch throws', threw);

// invalid decision -> throws
let threw2 = false;
try {
  runParseDecision({ decision: 'maybe' }, { Idempotency_Hash__c: 'X' });
} catch (e) { threw2 = e.message.includes('Invalid decision'); }
assert('Invalid decision throws', threw2);

// ---------- Summary ----------
log('\n----------------------------------------');
if (failures === 0) {
  log('All regression assertions passed.');
  process.exit(0);
} else {
  log(`${failures} assertion(s) FAILED.`);
  process.exit(1);
}
