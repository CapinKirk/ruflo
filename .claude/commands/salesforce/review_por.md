# Review POR Implementation

Pre-PR code review orchestration. Step 4 of the POR workflow.

## Prerequisites
- Implementation complete on feature branch
- All local tests passing

## Workflow

### 1. Detect Context
- Read current branch name → extract WI number
- Load ticket from `thoughts/shared/tickets/WI-{number}/ticket.md`
- Load plan from `thoughts/shared/plans/WI-{number}-plan.md`

### 2. Launch Specialist Reviews
Spawn review agents in parallel:

#### Architecture Review
- Design patterns followed correctly
- Trigger handler pattern compliance
- Sharing model declarations
- Governor limit patterns (no SOQL/DML in loops)
- Class size under 500 lines

#### Security Review
- CRUD/FLS checks where needed
- No hardcoded IDs or credentials
- Input validation on user-facing code
- XSS prevention in LWC

#### CPQ Review (if applicable)
- SBQQ.TriggerControl wrapping
- Kill-switch permission checks
- Subscription/Quote trigger chain safety

#### Test Review
- All changed classes have corresponding tests
- TestDataFactory usage (no @SeeAllData)
- Bulk testing (200+ records)
- Positive and negative assertions
- Edge cases covered

### 3. Local CI Checks
```bash
# Lint Apex
sf scanner run --target force-app/ --format table

# Validate against QA org
sf project deploy start \
  --manifest delta-package/package/package.xml \
  --target-org por-uat \
  --dry-run \
  --test-level RunSpecifiedTests \
  --tests {test-classes}
```

### 4. Drift Check
Compare implementation against plan and ticket:
- All acceptance criteria addressed?
- Any out-of-scope changes?
- Plan phases all completed?

### 5. Generate Review Summary
Post to Asana as HTML comment with:
- Files changed (with line counts)
- Tests added/modified
- Deployment readiness (pass/fail)
- Issues found (if any)
- PR readiness verdict

### 6. Output
- Review report with findings
- Action items for any issues
- PR readiness status (ready / needs fixes)

## Next Step
If review passes, run `/commit_por` then create PR via `gh pr create`.
After QA approval, run `/merge_por` for deploy-first-then-merge.
