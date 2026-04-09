# Start POR Work Item

Begin work on a Salesforce ticket from Asana. This is Step 1 of the POR development workflow.

## Input
Accepts: Asana task URL, WI number (e.g., WI-12345), or Asana task GID

## Workflow

### 1. Fetch Ticket from Asana
```bash
# Get task details via Asana API
curl -s -H "Authorization: Bearer $ASANA_PAT" \
  "https://app.asana.com/api/1.0/tasks/{task_gid}" | jq .
```
Extract: title, description, acceptance criteria, affected objects, assignee.

### 2. Create Feature Branch
```bash
# Branch from latest main
git checkout main && git pull origin main
git checkout -b feature/WI-{number}-{short-description}
```

### 3. Set Up Ticket Workspace
Create `thoughts/shared/tickets/WI-{number}/`:
- `ticket.md` — full ticket details from Asana
- `research/` — codebase research findings
- `plans/` — implementation plans

### 4. Research Codebase
Launch the `sf-codebase-analyzer` agent to:
- Identify affected Apex classes, triggers, flows
- Trace trigger handler chains for affected objects
- Find existing test classes
- Check for CPQ involvement (SBQQ__ fields/objects)

### 5. Select Target Org
- For development: use personal dev org (`sf org login web`)
- For validation: use por-uat
- Offer sandbox seeding if dev org needs data

### 6. Move Asana Task
Move task to "In Progress" section:
```bash
curl -s -X POST \
  -H "Authorization: Bearer $ASANA_PAT" \
  -H "Content-Type: application/json" \
  -d '{"data":{}}' \
  "https://app.asana.com/api/1.0/sections/1209047939293812/addTask"
```

### 7. Output
- Summary of ticket requirements
- List of affected files/objects
- Suggested implementation approach
- Branch name and target org

## Next Step
Run `/plan_por` to create an implementation plan.
