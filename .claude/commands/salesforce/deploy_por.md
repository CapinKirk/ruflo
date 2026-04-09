# Deploy POR (Ad-Hoc Deployment)

Deploy Salesforce metadata to QA, UAT, or PROD using delta packages.

## Usage
Specify target environment: `QA`, `UAT`, or `PROD`

## Workflow

### 1. Generate Delta Package
```bash
npx sfdx-git-delta --from origin/main --to HEAD --output delta-package/
```

### 2. Review Changes
List components in the delta:
```bash
cat delta-package/package/package.xml
```

### 3. Identify Test Classes
For each changed Apex class/trigger, find corresponding test:
- `FooBar.cls` → `FooBarTest.cls`
- `{Object}Trigger.trigger` → `{Object}TriggerTest.cls`

### 4. Validate (Dry Run)
```bash
sf project deploy start \
  --manifest delta-package/package/package.xml \
  --target-org {org-alias} \
  --test-level RunSpecifiedTests \
  --tests {TestClass1,TestClass2} \
  --dry-run
```

### 5. Deploy
```bash
sf project deploy start \
  --manifest delta-package/package/package.xml \
  --target-org {org-alias} \
  --test-level RunSpecifiedTests \
  --tests {TestClass1,TestClass2} \
  --wait 30
```

### 6. Verify
```bash
sf project deploy report --target-org {org-alias}
```

## Environment Map
| Environment | Org Alias | When to Use |
|------------|-----------|-------------|
| QA | `por-uat` | After implementation, before PR review |
| UAT | `por-uat` | Stakeholder validation |
| PROD | `por-prod` | After PR approved and QA passed |

## Safety
- ALWAYS validate (dry-run) before deploying
- ALWAYS use delta packages
- ALWAYS run targeted tests (not RunAllTests)
- NEVER deploy to PROD without prior QA validation
- For PROD: prefer `/merge_por` (deploy-first-then-merge pattern)
