# Commit POR

Interactive git commit with Conventional Commits format for Salesforce work.

## Commit Format
```
<type>(WI-{number}): <description>

[optional body with details]
```

### Types
| Type | When |
|------|------|
| `feat` | New feature or functionality |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, whitespace (no logic change) |
| `refactor` | Code restructure (no behavior change) |
| `test` | Adding or fixing tests |
| `chore` | Build, config, tooling changes |

## Workflow

### 1. Analyze Changes
```bash
git status
git diff --stat
git diff
```

### 2. Stage Files
Stage related files together. Never use `git add -A` or `git add .`.
```bash
git add force-app/main/default/classes/MyClass.cls
git add force-app/main/default/classes/MyClass.cls-meta.xml
git add force-app/main/default/classes/MyClassTest.cls
git add force-app/main/default/classes/MyClassTest.cls-meta.xml
```

### 3. Draft Commit Message
- Extract WI number from branch name
- Summarize the change (what and why, not how)
- Keep subject line under 72 characters

### 4. Confirm with User
Show the proposed commit message and staged files. Wait for approval before executing.

### 5. Commit
```bash
git commit -m "feat(WI-12345): add account validation for duplicate detection"
```

## Rules
- One logical change per commit
- Always include WI number in parentheses
- Never commit `.env`, credentials, or IDE-specific files
- Ensure all staged tests pass before committing
