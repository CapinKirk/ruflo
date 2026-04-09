---
description: Salesforce Apex, LWC, and metadata code style rules for POR org
globs: ["force-app/**/*.cls", "force-app/**/*.trigger", "force-app/**/*.js", "force-app/**/*.html"]
---

# Salesforce Code Style Rules

## Apex Naming
- Classes: `PascalCase` (e.g., `AccountTriggerHandler`)
- Methods/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Test classes: `{ClassName}Test`
- Triggers: `{Object}Trigger`
- Batch jobs: `{Object}{Action}Batch`

## Apex Structure
- ALL classes must declare explicit sharing (`with sharing`, `without sharing`, or `inherited sharing`)
- ALL conditionals must use braces (no single-line if)
- ALL trigger handlers implement `TriggerHandler` interface
- ALL automation checks `FeatureManagement.checkPermission('Bypass_Triggers')` before executing
- Debug logging: `System.debug(LoggingLevel.INFO, 'message');`
- Max class size: 500 lines

## LWC Naming
- Components: `camelCase` (e.g., `accountDetailCard`)
- Event handlers: `handle{EventName}` (e.g., `handleSave`)

## Testing
- Use `TestDataFactory` for all test data
- NEVER `@SeeAllData=true`
- Assert specific values, not "not null"
- Test bulk operations (200+ records)
- Test classes: `@IsTest` annotation

## API Version
- Target: v66.0 for all metadata

## CPQ Safety
- ALWAYS wrap subscription updates with `SBQQ.TriggerControl.disable()/enable()`
- Use try/finally to ensure triggers are re-enabled
