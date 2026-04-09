# POR Salesforce Development Workflow

Full 11-step workflow for Salesforce development at Point of Rental.

## Workflow Steps

| Step | Command | Description |
|------|---------|-------------|
| 1 | `/start_por` | Fetch Asana ticket, create branch, research codebase |
| 2 | `/plan_por` | Create implementation plan with phases |
| 3 | `/implement_por` | Execute approved plan with parallel phases |
| 4 | `/commit_por` | Interactive git commit with conventional format |
| 5 | `/review_por` | Pre-PR review with specialist agents |
| 6 | `gh pr create` | Create pull request (standard GitHub CLI) |
| 7 | `/deploy_por` | Ad-hoc deployment to QA/UAT/PROD |
| 8 | `/merge_por` | Deploy-first-then-merge to PROD |
| 9 | `/finish_por` | Generate release documentation |

## Conventions

### Branch Naming
```
feature/WI-{number}-{short-description}
fix/WI-{number}-{short-description}
hotfix/WI-{number}-{short-description}
```

### Commit Format (Conventional Commits)
```
<type>(WI-{number}): <description>

Types: feat, fix, docs, style, refactor, test, chore
```

### Deployment Path
```
Developer Org → QA (por-uat) → UAT (por-uat) → PROD (por-prod)
```
Always delta deployments via `sfdx-git-delta`. Never full source deploy.

### Salesforce CLI
```bash
sf data query --target-org por-prod -q "SELECT Id FROM Account LIMIT 1"
sf data query --target-org por-uat -q "SELECT Id FROM Account LIMIT 1"
```

## Quick Reference

### Key Files
- Ticket workspace: `thoughts/shared/tickets/WI-{number}/`
- Plans: `thoughts/shared/plans/WI-{number}-plan.md`
- Source code: `force-app/main/default/`

### Org Aliases
- Production: `por-prod`
- UAT: `por-uat`

### API Version
- Target: v66.0

### Asana Integration
- Workspace: `247986675893735`
- RevTech Project: `1209024971684846`
- Kirk's GID: `1201176831647150`
