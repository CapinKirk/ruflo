#!/usr/bin/env node
// Africa-triage smoke test — sends the real interactive Slack message to Kirk
// (and optionally Dean), with buttons that capture clicks to webhook.site.
//
// Usage:
//   node deliverables/r360-africa-triage/tests/smoke-test.mjs           # Kirk only
//   node deliverables/r360-africa-triage/tests/smoke-test.mjs --to-dean # Kirk + Dean
//   node deliverables/r360-africa-triage/tests/smoke-test.mjs --preview # just print
//
// Required env: SLACK_BOT_TOKEN (xoxb-...) with chat:write scope.
// Capture URL: https://webhook.site/ecce62b5-31f8-4fdd-b915-268f86256625
// Click viewer: https://webhook.site/#!/ecce62b5-31f8-4fdd-b915-268f86256625

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const TRIAGE_PATH = path.join(REPO_ROOT, 'deliverables/r360-africa-triage/n8n/sub-r360-africa-triage.json');

const ARGS = new Set(process.argv.slice(2));
const SEND_TO_DEAN = ARGS.has('--to-dean');
const PREVIEW_ONLY = ARGS.has('--preview');

const KIRK_USER_ID = 'U02HR1T6PBK';
const DEAN_USER_ID = 'U0135HAS0KA';

const CAPTURE_UUID = 'ecce62b5-31f8-4fdd-b915-268f86256625';
const CAPTURE_BASE = `https://webhook.site/${CAPTURE_UUID}`;
const VIEW_URL = `https://webhook.site/#!/${CAPTURE_UUID}`;

// --- Build the Block Kit message using the workflow's actual code ---

const triage = JSON.parse(fs.readFileSync(TRIAGE_PATH, 'utf8'));
const buildCode = triage.nodes.find(n => n.name === 'Code: Build Slack Block Kit message').parameters.jsCode;

// Realistic smoke-test payload — Africa lead with an existing SF Lead match.
const fixture = {
  Idempotency_Hash__c: `SMOKE-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`,
  source: 'wpform_29710',
  formattedRegion: 'Africa',
  formattedFirst: 'Thabo',
  formattedLast: 'Mokoena',
  formattedEmail: 'thabo.mokoena@example.co.za',
  formattedCompany: 'Mokoena Equipment Rentals (SMOKE TEST)',
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

// The workflow's code references $execution.resumeUrl. For the smoke test we
// substitute a webhook.site URL — the click will be captured there instead of
// resuming a real n8n execution.
const fakeExecution = {
  id: `SMOKE-EXEC-${Date.now()}`,
  resumeUrl: CAPTURE_BASE
};

const fn = new Function('$json', '$execution', buildCode);
const built = fn(fixture, fakeExecution)[0].json;

// Prepend a "this is a smoke test" header so nobody mistakes it for a real lead.
const smokeBlocks = [
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: ':test_tube: *SMOKE TEST — not a real lead.* Kirk Bennett is validating the Africa-triage workflow. Clicking a button below logs the click to <' + VIEW_URL + '|webhook.site> instead of routing to Salesforce. Please click whichever button you would normally click so Kirk can confirm the round-trip works.'
    }
  },
  { type: 'divider' },
  ...built.slack_blocks
];

const fallbackText = `[SMOKE TEST] ${built.slack_fallback_text}`;

// --- Preview mode: print the JSON and exit ---

if (PREVIEW_ONLY) {
  console.log('--- Slack DM payload (preview only, not sent) ---');
  console.log(JSON.stringify({ text: fallbackText, blocks: smokeBlocks }, null, 2));
  console.log('\nClick viewer:', VIEW_URL);
  process.exit(0);
}

// --- Send via Slack Web API ---

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
if (!SLACK_BOT_TOKEN) {
  console.error('ERROR: SLACK_BOT_TOKEN env var is not set. Export an xoxb-... token with chat:write.');
  console.error('Re-run with --preview to inspect the payload without sending.');
  process.exit(2);
}

async function postMessage(channelUserId, label) {
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      channel: channelUserId,
      text: fallbackText,
      blocks: smokeBlocks
    })
  });
  const data = await resp.json();
  if (!data.ok) {
    console.error(`  FAIL  ${label}: ${data.error} ${data.response_metadata?.messages?.join(', ') || ''}`);
    return null;
  }
  console.log(`  PASS  ${label}: channel=${data.channel} ts=${data.ts}`);
  return data;
}

console.log('Sending Africa-triage smoke message...\n');
console.log(`  Fixture hash: ${fixture.Idempotency_Hash__c}`);
console.log(`  Capture URL:  ${CAPTURE_BASE}`);
console.log(`  Click viewer: ${VIEW_URL}\n`);

const kirkResult = await postMessage(KIRK_USER_ID, 'DM to Kirk Bennett');

let deanResult = null;
if (SEND_TO_DEAN) {
  deanResult = await postMessage(DEAN_USER_ID, 'DM to Dean Hammond');
} else {
  console.log('  SKIP  DM to Dean (re-run with --to-dean to include)');
}

console.log('\n--- Smoke test sent ---');
console.log('Open Slack → check Kirk Bennett DM (and Dean Hammond if --to-dean).');
console.log(`Click the buttons; each click registers at: ${VIEW_URL}`);
console.log('Each captured request will show ?decision=continue or ?decision=kill plus &hash.');
console.log('\nWhen ready to "send for real" to Dean, re-run with --to-dean.\n');
