# Plan POR Implementation

Create an implementation plan for the current ticket. Step 2 of the POR workflow.

## Prerequisites
- Must have run `/start_por` first (active feature branch, ticket workspace exists)
- Branch should be `feature/WI-{number}-*`

## Workflow

### 1. Load Context
- Read `thoughts/shared/tickets/WI-{number}/ticket.md`
- Read any research files in the ticket workspace
- Detect current branch and WI number from git

### 2. Gather Intelligence
Spawn specialist agents to research:
- **sf-codebase-analyzer**: Analyze affected files, trigger chains, dependencies
- **sf-cpq-specialist**: If CPQ objects involved, analyze SBQQ patterns
- **sf-codebase-pattern-finder**: Find similar implementations as templates

### 3. Create Implementation Plan
Structure the plan with:

```markdown
# Implementation Plan: WI-{number}

## Summary
One-paragraph overview of what we're building.

## Phases
### Phase 1: {description}
- [ ] Task 1.1: {specific file + change}
- [ ] Task 1.2: {specific file + change}

### Phase 2: {description}
- [ ] Task 2.1: ...

## Parallel Execution
Phases that can run in parallel: [Phase 1, Phase 2] (no shared files)
Phases that must be sequential: [Phase 3 depends on Phase 1]

## Test Strategy
- Unit tests: {list test classes to create/modify}
- Integration: {validation steps}
- Manual QA: {steps for QA team}

## Deployment Notes
- Delta package components: {list}
- Destructive changes: {yes/no, what}
- Test level: RunSpecifiedTests
- Target tests: {list}

## Risks & Mitigations
- Risk: {description} → Mitigation: {approach}
```

### 4. Save Plan
Save to `thoughts/shared/plans/WI-{number}-plan.md`

### 5. Iterate
Present plan to user for review. Revise based on feedback until approved.

## Next Step
Run `/implement_por` to execute the approved plan.
