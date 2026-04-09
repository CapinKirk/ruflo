# Finish POR (Release Documentation)

Generate release documentation for a completed ticket. Step 9 of the POR workflow.

## Prerequisites
- Ticket deployed to PROD via `/merge_por`
- All acceptance criteria met

## Workflow

### 1. Gather Context
- Read ticket from `thoughts/shared/tickets/WI-{number}/ticket.md`
- Read plan from `thoughts/shared/plans/WI-{number}-plan.md`
- Review git log for all commits on the feature branch

### 2. Generate Backlog Note
Create `thoughts/shared/tickets/WI-{number}/backlog_note.md`:
- User-facing release note (500 words max)
- What changed from the user's perspective
- Any new features or behavior changes
- No technical implementation details

### 3. Generate Release Documentation
Create `thoughts/shared/tickets/WI-{number}/release_documentation.md`:
- Comprehensive user guide for the changes
- Step-by-step instructions for any new functionality
- Screenshots or diagrams if applicable
- Known limitations or caveats

### 4. Sync to Asana
Update the Asana task description with:
- Final status
- Link to PR (merged)
- Backlog note summary
- Release documentation link

### 5. Interactive Refinement
Present documentation to user for review. Iterate until approved.

## Output
- `backlog_note.md` — concise user-facing release note
- `release_documentation.md` — comprehensive guide
- Asana task updated with final documentation
