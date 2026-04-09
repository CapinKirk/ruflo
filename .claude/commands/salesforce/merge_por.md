# Merge POR (Deploy-First-Then-Merge)

Deploy to PROD then merge PR. Step 7 of the POR workflow.

## CRITICAL: Deploy-First Pattern
POR uses **deploy-first-then-merge**, NOT merge-then-deploy:
1. Generate delta package from feature branch
2. Deploy delta to PROD
3. If deployment succeeds → merge PR
4. If deployment fails → fix and retry (never merge broken code)

## Prerequisites
- PR approved and QA passed
- All review checks passed
- Feature branch up to date with main

## Workflow

### 1. Validate Readiness
```bash
# Ensure branch is up to date
git fetch origin main
git rebase origin/main

# Check PR status
gh pr status
```

### 2. Generate Delta Package
```bash
npx sfdx-git-delta --from origin/main --to HEAD --output delta-package/
```

### 3. Deploy to PROD
```bash
sf project deploy start \
  --manifest delta-package/package/package.xml \
  --target-org por-prod \
  --test-level RunSpecifiedTests \
  --tests {test-classes} \
  --wait 30
```

If destructive changes exist:
```bash
sf project deploy start \
  --manifest delta-package/package/package.xml \
  --post-destructive-changes delta-package/destructiveChanges/destructiveChanges.xml \
  --target-org por-prod \
  --test-level RunSpecifiedTests \
  --tests {test-classes} \
  --wait 30
```

### 4. Verify Deployment
```bash
sf project deploy report --target-org por-prod
```

### 5. Merge PR (Only After Successful Deploy)
```bash
gh pr merge --squash --delete-branch
```

### 6. Update Asana
- Move task to "Complete" section
- Post deployment confirmation comment with:
  - Deployment ID
  - Components deployed
  - Test results
  - Timestamp

### 7. Clean Up
```bash
git checkout main && git pull origin main
# Delete local feature branch
git branch -d feature/WI-{number}-*
```

## Next Step
Run `/finish_por` to generate release documentation.
