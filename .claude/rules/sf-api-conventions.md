---
description: Salesforce API version policy, deployment conventions, CPQ namespace, flow fault handling
globs: ["force-app/**/*-meta.xml", "sfdx-project.json", "force-app/**/*.flow-meta.xml"]
---

# Salesforce API & Deployment Conventions

## API Version
- Target: **v66.0** for all new metadata
- Match existing file version when editing (don't upgrade incidentally)
- `sfdx-project.json` defines the project-wide version

## Deployment
- ALWAYS delta deployments via `sfdx-git-delta`
- NEVER full source deploy (too slow, too risky)
- Test level: `RunSpecifiedTests` with targeted test classes
- Validation (dry-run) before every real deploy

## CPQ Namespace
- All CPQ objects/fields: `SBQQ__` prefix
- Never create custom fields on CPQ objects without explicit approval
- CPQ trigger control: `SBQQ.TriggerControl.disable()/enable()` wrapping

## Flow Conventions
- Fault paths: include Slack alert action for critical flows
- Flow names: `{Object}_{Action}_{Type}` (e.g., `Account_Update_After`)
- Use fault connectors on all DML operations

## Metadata Ordering
In `package.xml`:
1. CustomObject
2. CustomField
3. ApexClass
4. ApexTrigger
5. LightningComponentBundle
6. Flow
7. PermissionSet
8. Layout
9. FlexiPage
