# WI-21969 — QA Came From (Auto-Tag Last Dev on QA Handoff)

Auto-captures the assignee a task held at the moment it moved into **Quality Assurance**, into a People custom field, so QA handoffs are traceable and filterable.

- **Asana task:** https://app.asana.com/1/247986675893735/project/1209024971684846/task/1213989369437747
- **Status:** Live since 2026-05-17. **v3.3 is the current production version** (2026-05-25) — race-fixed, multi-item-trigger fixed, 404-tolerant on Get Task / Get Stories, stamps both `QA Came From` and `Entered QA At`, has a `Skip if not in QA` short-circuit, and errors page Slack via the shared `Error Notification - Slack` sub-workflow. Two complete backfill passes have run: 227 `QA Came From` writes (2026-05-24) + 228 `Entered QA At` writes (2026-05-25).
- **Implementation:** n8n workflow (not a native Asana Rule — see Decision).

This README is the complete spec. An AI agent or engineer can iterate using only what is below. The live source of truth for the node code is the n8n API; this file mirrors it and is regenerated from the deployed workflow.

---

## TL;DR for the next agent

- People custom field `QA Came From` (gid `1214876159436964`) on the RevTech project.
- n8n workflow id `qnsfpxXNAGE7hoSe` on `https://n8nweb.ec-ops.org` listens to *every* RevTech project event via an Asana webhook, filters to "task moved into the Quality Assurance section", **reads the task's story history to find the pre-move assignee**, and writes that person into `QA Came From`.
- v3 (current) is race-safe: even when the assignee is cleared 1–2s after a section move (common QA-handoff pattern), the story-history lookup still recovers the correct person.
- Loop-safe and idempotent. Proven empirically — see Verification.
- To change behavior: edit via n8n REST API (commands below). Source JSON is committed alongside this file.

## Why this is n8n and not a native Asana Rule

Native Asana Rules can set a **People** custom field only to a **statically chosen** person. They cannot dynamically copy "whoever is currently the assignee" into a People field unless the workspace tier exposes the Smart Rules / Workflow-Bundle *"Copy field value"* action, which is not reliably available here. Even if it were, the **story-based** algorithm v3 uses can't be expressed in any native rule — it inspects the task's audit log. n8n is the only viable host.

## Canonical identifiers

| Thing | Value |
|---|---|
| Custom field `QA Came From` | gid `1214876159436964`, `resource_subtype: people` |
| Custom field `Entered QA At` | gid `1215085559448866`, `resource_subtype: date` (date_time precision) |
| Error sub-workflow (Slack pager) | n8n workflow id `XaNTnsikRThG3w4R` — `Error Notification - Slack` (shared org-wide). Wired via `settings.errorWorkflow` on the main workflow. |
| RevTech project | gid `1209024971684846` |
| Workspace (pointofrental.com) | gid `247986675893735` |
| "Quality Assurance" section (trigger column) | gid `1209047939293885` |
| "Backlog" section (used in test runbook) | gid `1209047939293840` |
| n8n workflow id | `qnsfpxXNAGE7hoSe` |
| n8n workflow name | `WI-21969 QA Came From — RevTech section→QA capture` |
| n8n instance | `https://n8nweb.ec-ops.org` (API base `https://n8nweb.ec-ops.org/api/v1`) |
| Asana webhook | n8n-managed; current gid changes on every (de)activation. Confirm with `GET /webhooks?workspace=247986675893735&resource=1209024971684846` (look for target path `c04e239e-59fe-4057-8d44-f10b231525d1`). |
| n8n Asana credential | type `asanaApi`, id `btWEfsyysFLJEM7I`, name "Asana account" (shared — do not duplicate) |
| Ops env file (curl only, not used by n8n) | `v3/.env` → `ASANA_PAT`, `N8N_API_BASE`, `N8N_API_KEY`, `N8N_WEBHOOK_SECRET` |

## How the custom field was created (reproducible)

Two Asana REST calls (API v1.0, bearer = `ASANA_PAT`):

```bash
# 1) create the People field at workspace scope
POST https://app.asana.com/api/1.0/custom_fields
{ "data": { "workspace": "247986675893735", "name": "QA Came From",
            "description": "Auto-populated by automation: the assignee who held the task immediately before it was moved into Quality Assurance.",
            "resource_subtype": "people", "people_value": {} } }
# -> returns data.gid = 1214876159436964

# 2) attach it to the RevTech project, marked important
POST https://app.asana.com/api/1.0/projects/1209024971684846/addCustomFieldSetting
{ "data": { "custom_field": "1214876159436964", "is_important": true,
            "insert_after": "1212516039005548" } }
```

Destructive reset: `DELETE /custom_fields/1214876159436964` (also detaches from project and clears all values everywhere).

## Architecture / data flow (v3.3)

Linear 7-node pipeline. Connections: `Trigger → Filter → Get Task → Skip if not in QA → Get Stories → Decide → Set`. Failures route to the shared Slack-pager sub-workflow via `settings.errorWorkflow`. Get Task and Get Stories use `onError: 'continueRegularOutput'` so deleted-task 404s flow downstream as error bodies and are dropped silently by Skip / Decide. Filter iterates every trigger item via `$input.all()` to handle Asana's multi-event webhook batches.

```
Asana Trigger: RevTech Project   (n8n-managed Asana webhook; ALL project events)
  → Filter: only QA section moves   (passes only "task added to QA section"; else 0 items)
  → Asana: Get Task                 (assignee + memberships + custom_fields)
  → Skip if not in QA               (v3.2 — short-circuit before the Stories fetch
                                     if task isn't currently in QA; saves the wasted
                                     Stories GET on Shape-B non-QA section moves)
  → Asana: Get Stories              (v3 — full audit log for assignee derivation)
  → Decide: write QA Came From?     (story-based pre-move assignee; idempotency check)
  → Asana: Set QA Came From + Entered QA At
                                     (v3.2 — single PUT writes BOTH custom fields:
                                     QA Came From = preMoveAssigneeGid,
                                     Entered QA At = T_move ISO timestamp)
```

Asana webhooks cannot be scoped to a single section — the hook is project-wide, hence the Filter node.

## Node-by-node spec (exact, as deployed v3)

### 1. Asana Trigger: RevTech Project
`n8n-nodes-base.asanaTrigger` (typeVersion 1). Credential `asanaApi` id `btWEfsyysFLJEM7I`.
```json
{ "resource": "1209024971684846", "workspace": "247986675893735" }
```

### 2. Filter: only QA section moves
`n8n-nodes-base.code` (typeVersion 2). Forwards `triggerUserGid` so Decide can use it as last-resort fallback.
```javascript
const QA_SECTION_GID = '1209047939293885';
const event = $json;
const triggerUserGid = (event.user && event.user.gid) || null;
const eventCreatedAt = event.created_at || null;

if (event.action === 'added' &&
    event.resource && event.resource.resource_type === 'task' &&
    event.parent && event.parent.resource_type === 'section' &&
    event.parent.gid === QA_SECTION_GID) {
  return [{ json: { taskGid: event.resource.gid, source: 'direct_add',
                    qaSectionGid: QA_SECTION_GID, triggerUserGid, eventCreatedAt } }];
}
if (event.action === 'added' &&
    event.resource && event.resource.resource_type === 'story' &&
    event.resource.resource_subtype === 'section_changed' &&
    event.parent && event.parent.resource_type === 'task') {
  return [{ json: { taskGid: event.parent.gid, source: 'section_changed_story',
                    qaSectionGid: QA_SECTION_GID, triggerUserGid, eventCreatedAt } }];
}
return [];
```

### 3. Asana: Get Task
`n8n-nodes-base.httpRequest` (typeVersion 4.2). Credential `asanaApi`. URL:
```
=https://app.asana.com/api/1.0/tasks/{{ $json.taskGid }}?opt_fields=name,assignee.gid,assignee.name,memberships.section.gid,memberships.section.name,custom_fields.gid,custom_fields.name,custom_fields.people_value
```

### 4. Asana: Get Stories (NEW in v3)
`n8n-nodes-base.httpRequest` (typeVersion 4.2). Credential `asanaApi`. **URL must reference Filter explicitly** (after Get Task, `$json` is the task body, not the Filter output):
```
=https://app.asana.com/api/1.0/tasks/{{ $('Filter: only QA section moves').first().json.taskGid }}/stories?opt_fields=resource_subtype,created_at,assignee.gid,assignee.name,new_section.gid,new_section.name&limit=100
```

### 5. Decide: write QA Came From?
`n8n-nodes-base.code` (typeVersion 2). The race-fix lives here.
```javascript
const QA_SECTION_GID = '1209047939293885';
const QA_CAME_FROM_FIELD_GID = '1214876159436964';

const storiesResp = $json;
const stories = (storiesResp && storiesResp.data) ? storiesResp.data : (storiesResp.stories || []);
const taskResp = $('Asana: Get Task').first().json;
const task = (taskResp && taskResp.data) ? taskResp.data : taskResp;
const upstream = $('Filter: only QA section moves').first().json;
const triggerUserGid = upstream.triggerUserGid || null;

const inQA = (task.memberships || []).some(m => m && m.section && m.section.gid === QA_SECTION_GID);
if (!inQA) { return []; }

// 1) T_move = created_at of most recent section_changed -> QA story
const qaMoveStories = stories
  .filter(s => s && s.resource_subtype === 'section_changed' && s.new_section && s.new_section.gid === QA_SECTION_GID)
  .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
const tMove = qaMoveStories.length ? new Date(qaMoveStories[0].created_at) : null;

// 2) walk assigned/unassigned events up to T_move; latest wins
let preMoveAssignee = null;
let derivedFrom = 'none';
let intentionallyUnassigned = false;
if (tMove) {
  const assignmentEvents = stories
    .filter(s => s && (s.resource_subtype === 'assigned' || s.resource_subtype === 'unassigned'))
    .filter(s => new Date(s.created_at) <= tMove)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (assignmentEvents.length) {
    const last = assignmentEvents[assignmentEvents.length - 1];
    if (last.resource_subtype === 'assigned' && last.assignee && last.assignee.gid) {
      preMoveAssignee = last.assignee;
      derivedFrom = 'story.assigned';
    } else if (last.resource_subtype === 'unassigned') {
      intentionallyUnassigned = true;
    }
  }
}

// 3) fallback: current assignee (lucky path — no race)
if (!preMoveAssignee && !intentionallyUnassigned && task.assignee && task.assignee.gid) {
  preMoveAssignee = task.assignee;
  derivedFrom = 'task.assignee (current)';
}

// 4) last resort: the drag actor
if (!preMoveAssignee && !intentionallyUnassigned && triggerUserGid) {
  preMoveAssignee = { gid: triggerUserGid, name: '(trigger user)' };
  derivedFrom = 'trigger.user (last resort)';
}

if (!preMoveAssignee) { return []; }

// idempotency
const existing = (task.custom_fields || []).find(f => f && f.gid === QA_CAME_FROM_FIELD_GID);
const alreadySet = existing && existing.people_value && existing.people_value.length === 1 &&
                   existing.people_value[0].gid === preMoveAssignee.gid;
if (alreadySet) { return []; }

return [{
  json: {
    taskGid: task.gid, taskName: task.name,
    assigneeGid: preMoveAssignee.gid, assigneeName: preMoveAssignee.name,
    qaCameFromFieldGid: QA_CAME_FROM_FIELD_GID,
    derivedFrom, tMove: tMove ? tMove.toISOString() : null
  }
}];
```

### 6. Asana: Set QA Came From
`n8n-nodes-base.httpRequest` (typeVersion 4.2). Method `PUT`. URL `=https://app.asana.com/api/1.0/tasks/{{ $json.taskGid }}`. JSON body:
```json
={
  "data": {
    "custom_fields": {
      "{{ $json.qaCameFromFieldGid }}": "{{ $json.assigneeGid }}"
    }
  }
}
```

## Incident: v3.2 deleted-task 404 + multi-item Filter bug (RCA, 2026-05-25)

**Symptom 1 — Slack alert:** `Asana: Get Task` failed with HTTP 404 `task: Not a recognized ID: 1215104917252042` on execution 491549. The task had been deleted between the section_changed story firing and n8n's GET landing ~4s later. This is a transient/expected race (webhook delivery is at-least-once; tasks can be deleted at any moment).

**Symptom 2 — discovered while writing the test:** during validation of the 404 fix, I noticed the Asana trigger emits multiple events per webhook batch (story:assigned + task added to section + custom_field_changed, etc.) but **n8n's Code node defaults to `runOnceForAllItems` mode, where `$json` is the FIRST item only**. The Filter node's `if (event.action === ...)` check only inspected the first item. Any QA-move event that wasn't the first item in the batch was silently dropped. In one test execution, item 0 was `story/assigned` (no match) and item 1 was a perfect Shape A QA move (parent.gid = QA section) — Filter emitted 0 and we missed the capture. This was likely happening sporadically since v1.

**Fix (v3.3):**
1. Set `onError: 'continueRegularOutput'` on `Asana: Get Task` and `Asana: Get Stories`. A 404 (or any HTTP error) now emits the error body as a regular output instead of failing the execution.
2. Hardened `Skip if not in QA`: returns `[]` if `$json.errors` is an array (Asana's error-body shape) or if `task.memberships` is missing. The 404 flows downstream and is dropped silently — no Slack page.
3. Hardened `Decide` for symmetry: drops if Get Stories returned an error body too.
4. Rewrote `Filter` to iterate every input item via `$input.all()` (instead of relying on `$json` which is the first item only). Added a dedupe to handle the case where Shape A and Shape B fire for the same task in one batch.

**Backfill (one-time, 2026-05-25):** Re-audited 3,511 downstream-of-QA tasks. Found 228 missing the new `Entered QA At` field (originally written 2026-05-24 when the field didn't exist yet). All 228 backfilled, zero failures.

**Lesson:** n8n Code node mode is a footgun. Default `runOnceForAllItems` makes `$json` mean "first item" — counterintuitive. Always use `$input.all()` in Code nodes that need to handle multi-item input. Recorded as a reference memory.

## Incident: v1 race condition (RCA, 2026-05-24)

**Symptom:** WI-22422 sitting in QA with empty `QA Came From`. Audit found this was the rule, not the exception — **50% of real-world QA moves were missing the write**.

**Root cause:** In Asana, the standard QA-handoff pattern is *drag card to QA, then immediately unassign* so a QA person can claim it. The Asana webhook is delivered ~3s after the move; n8n's `GET /tasks/{id}` lands AFTER the assignee-clear that follows ~2s after the move. v1 read `task.assignee` at fetch time, saw `null`, and (correctly per v1 logic) dropped the run — but the assignee *had* been set at the moment of the move.

| t (UTC) | Event | Effect |
|---|---|---|
| 23:49:14.973 | task `added` to QA section | move event ✅ |
| 23:49:17.079 | `assignee` cleared to `null` | the killer |
| 23:49:18.583 | n8n `GET /tasks/{id}` returns `assignee: null` | races + loses |

**Why the original "known limitation" framing was wrong:** v1's writeup treated this as edge case ("reassign before move"). It is in fact the dominant QA-handoff pattern. Real-world miss rate before the fix was 50% (1 of 2 visible cases).

**Fix (v3):** Stop trusting `task.assignee` at fetch time. Read the task's story log instead — Asana stories are immutable so the pre-move assignee is recoverable even after a clear/reassign races us. Two earlier attempts (v2.0 had an `$json.taskGid` reference bug; v2.1 used the wrong story subtype name `assignee_changed` which doesn't exist — Asana uses `assigned`/`unassigned`). v3 is the version actually deployed.

**Historical backfill (one-time, 2026-05-24):** Audited all 3,506 unique tasks across downstream-of-QA sections (QA / UAT / Ready to Release / Production / Rejected). Found **227** with empty `QA Came From` whose story history allowed deriving the pre-move assignee; all written. The remaining 3,255 legitimately never moved through QA in their lifetime (operational/legacy work created directly in Production etc.). Backfill scripts: `/tmp/audit_qa_came_from.py`, `/tmp/backfill_qa_came_from.py`, `/tmp/backfill_pass2_parallel.py`, `/tmp/backfill_pass3_retry.py` (one-time tooling — not committed).

## Loop safety & idempotency

Writing the field (node 6) makes Asana emit a `custom_fields changed` event back to the same webhook. That re-entrant event is **not** `action:'added'` with a section parent, so Filter (node 2) emits 0 items and the run stops — primary loop-breaker. Second layer: Decide's `alreadySet` check drops the run if `QA Came From` already equals the chosen assignee. Both observed working empirically.

## Edge-case behavior (v3)

| Scenario | Behavior |
|---|---|
| Standard QA handoff (move + immediate unassign) | ✅ Captures the pre-move assignee via story log |
| Move to QA, no assignee changes | ✅ Captures via story log OR current `task.assignee` |
| No assignee at all and no story | Falls back to `trigger.user` (the dragger) |
| Intentionally unassigned at move time (last pre-move story is `unassigned`) | No write — preserves "was genuinely empty" semantics |
| Moved OUT of QA | Not an "added to QA" event → Filter drops; field intentionally NOT cleared (historical trace) |
| Moved INTO QA again later | Overwrites with newly-derived pre-move assignee (latest hand-off wins) |
| Bulk move many tasks into QA | One event per task; each processed independently |
| Reassigned to QA-person *before* move (uncommon) | Captures the QA-person (still incorrect, but rare enough to defer) |

## Verification evidence

**2026-05-17 — original v1 deployment:** 1 manual end-to-end pass against WI-21969.

**2026-05-24 — v3 deployment:** reproduced WI-22422's race pattern against a throwaway test task — assignee=Kirk, moved into QA, then cleared 1s later. Execution `477646`: `Filter → Get Task → Get Stories → Decide (derivedFrom=story.assigned, assignee=Kirk Bennett) → Set` ✅. Post-state: `assignee: null`, `QA Came From: Kirk Bennett`.

**Historical backfill:** 227 tasks written with zero failures.

## Access / modify / redeploy (n8n REST API)

Base `https://n8nweb.ec-ops.org/api/v1`, header `X-N8N-API-KEY: $N8N_API_KEY`.
```
GET    /workflows/qnsfpxXNAGE7hoSe                              # source of truth
PUT    /workflows/qnsfpxXNAGE7hoSe                              # body: {name, nodes, connections, settings}
POST   /workflows/qnsfpxXNAGE7hoSe/deactivate
POST   /workflows/qnsfpxXNAGE7hoSe/activate                     # (re)registers Asana webhook
GET    /executions?workflowId=qnsfpxXNAGE7hoSe&limit=10
GET    /executions/{executionId}?includeData=true               # full node IO + errors
```
After a trigger change, deactivate → activate; then confirm with:
`GET https://app.asana.com/api/1.0/webhooks?workspace=247986675893735&resource=1209024971684846` → expect an active hook targeting path `c04e239e-59fe-4057-8d44-f10b231525d1`.

## End-to-end test runbook (safe, repeatable — reproduces the race-fix path)

Use a throwaway task. To exercise the v3 story-based path specifically:

1. Create or pick a task in the RevTech project; assign it to someone (the "dev"), in any non-QA section.
2. Clear `QA Came From`: `PUT /tasks/{id}` body `{"data":{"custom_fields":{"1214876159436964":[]}}}`.
3. Move into QA: `POST /sections/1209047939293885/addTask` body `{"data":{"task":"{id}"}}`.
4. **Within 1–2 seconds**, clear the assignee: `PUT /tasks/{id}` body `{"data":{"assignee":null}}`. This reproduces the WI-22422 race.
5. Wait ~15s. `GET /tasks/{id}?opt_fields=custom_fields.name,custom_fields.display_value,custom_fields.people_value.name` — expect `QA Came From` = the dev from step 1, even though `assignee: null`.
6. Inspect the n8n execution: expect `derivedFrom = "story.assigned"`.
7. Cleanup: move back out of QA and clear the field.

## Backfill plan replay (if you need to re-run)

The audit + backfill scripts are intentionally not checked in (one-time tooling). The shape is:

1. Pull every task in each downstream-of-QA section (QA, UAT, Ready to Release, Production, Rejected). Use `GET /sections/{gid}/tasks` with pagination.
2. For each task with `QA Came From` empty, `GET /tasks/{gid}/stories` (paginated, up to 12 pages).
3. Apply the same algorithm as Decide node v3 (`section_changed → QA` gives T_move; latest `assigned`/`unassigned` <= T_move decides the answer).
4. Write derived value with `PUT /tasks/{gid}` body `{"data":{"custom_fields":{"1214876159436964":"{gid}"}}}`.
5. Concurrency: 6 workers + exponential backoff on `429` works against Asana's rate limit; 24 workers gets throttled.

## Next-iteration backlog

- Add a Slack alert on any execution `error` (we caught the v1 → v2 deploy bug only because I happened to test; production should not depend on that).
- Trigger-side optimization: today, every non-QA section move still costs one `GET /tasks` because Shape B (section_changed story) forwards optimistically. Detecting the destination section at Filter time would avoid those calls. Low priority — they're not wasteful enough to matter.
- "Entered QA At" date field stamped in the same write for bottleneck dwell-time reporting.
- Reassign-to-QA-person-*before*-move case (still wrong in v3, rare in practice — would need to track the previous-previous assignee, more state required).

## Files

```
deliverables/wi-21969-qa-came-from/
├── README.md                       ← this file (full spec, mirrors live v3)
└── n8n/
    └── qa_came_from.workflow.json  ← exported workflow definition (importable into n8n)
```
