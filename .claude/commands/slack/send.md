# Slack Send

Send a formatted Slack message to a user or channel.

## Usage
```
/slack-send @Andrea Salgado "message content here"
/slack-send #channel-name "message content here"
```

## Workflow

1. **Resolve recipient** — Look up Slack user ID from cache (memory namespace `slack-users`) or via `users.list` API
2. **Format content** — Use the `slack-formatter` agent to compose Block Kit blocks with proper mrkdwn, @mentions (`<@USERID>`), and POR custom emoji
3. **Deliver** — Use the `slack-messenger` agent to open DM/channel and send via `chat.postMessage`
4. **Cache** — Store any new user IDs in memory for future lookups

## Token

Load from `~/Claude-Codex/AnniversaryBot/.env.local` (SLACK_TOKEN) or `~/Claude-Codex/RevOpsCommentCapture/.env.local` (SLACK_REACTION_TOKEN). Never hardcode.

## Key Rules

- ALWAYS use `<@USERID>` mentions, never plain text names
- ALWAYS include a `text` fallback for push notifications
- Use Block Kit for any structured content (RCA, status, alerts)
- Keep messages brief: bullets over paragraphs, max 8 blocks before threading
- Add POR custom emoji sparingly (1-3 per message) for visual clarity
- Verify `.ok == true` on every API response

## Agents

- `slack-formatter` — Content composition, mrkdwn, Block Kit, emoji, templates
- `slack-messenger` — API delivery, user lookup, DM/channel management, threading
