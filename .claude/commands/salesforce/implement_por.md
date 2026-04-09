# Implement POR Plan

Execute an approved implementation plan. Step 3 of the POR workflow.

## Prerequisites
- Approved plan at `thoughts/shared/plans/WI-{number}-plan.md`
- Active feature branch `feature/WI-{number}-*`

## Workflow

### 1. Load Plan
- Read the approved plan file
- Identify phases and their dependencies
- Determine which phases can run in parallel

### 2. Execute Phases
For each phase, implement the changes following POR conventions:

#### Apex Code Style
- `PascalCase` for classes, `camelCase` for methods/variables
- Explicit sharing: `with sharing` or `without sharing` on every class
- Classes under 500 lines
- Kill-switch check: `if (FeatureManagement.checkPermission('Bypass_Triggers')) return;`
- Debug logging: `System.debug(LoggingLevel.INFO, 'message');`
- Braces on all conditionals (no single-line if statements)

#### Trigger Pattern
```apex
trigger {Object}Trigger on {Object} (before insert, before update, ...) {
    new {Object}TriggerHandler().run();
}
```
Handler implements `TriggerHandler` interface with 7 context methods.

#### Test Requirements
- Test class: `{ClassName}Test`
- Use `TestDataFactory` for all test data
- Never `@SeeAllData=true`
- Assert on specific values, not just "not null"
- Test bulk operations (200+ records)
- Test with and without `Bypass_Triggers` permission

#### LWC Conventions
- `camelCase` component names
- Jest tests in `__tests__/` directory
- Wire adapters for Apex calls
- Error handling with toast messages

### 3. Parallel Phase Execution
If plan identifies parallel phases, spawn `phase-implementer` agents:
```
Agent({ subagent_type: "phase-implementer", prompt: "Implement Phase N...", run_in_background: true })
```

### 4. Validation
After each phase:
- Run related test classes locally
- Verify no new PMD/lint warnings
- Check governor limit patterns (no SOQL/DML in loops)

### 5. Commit Progress
After each phase completes, commit with conventional format:
```
feat(WI-{number}): {phase description}
```

## Next Step
Run `/review_por` for pre-PR code review.
