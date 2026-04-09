---
name: Zoom Transcript
description: Fetch and analyze Zoom meeting transcripts. Pulls transcripts via Server-to-Server OAuth, extracts action items, decisions, and key discussion points. Use when referencing meeting transcripts, one-on-ones, or Zoom recordings.
---

# Zoom Transcript

Fetch, search, and analyze Zoom meeting transcripts on demand.

## What This Skill Does

Connects to the Zoom API using Server-to-Server OAuth credentials (stored in `.env`) to pull meeting transcripts, then analyzes them for action items, decisions, and key points.

## Prerequisites

- `.env` file with `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`
- `src/integrations/zoom/` integration code installed
- Node.js with tsx available

## Quick Start

```bash
# Today's transcripts
npx tsx src/integrations/zoom/fetch-transcript.ts --date today

# Specific date
npx tsx src/integrations/zoom/fetch-transcript.ts --date 2026-04-09

# Specific meeting
npx tsx src/integrations/zoom/fetch-transcript.ts --meeting-id <ID>
```

## Usage

When this skill is invoked:

1. Run the fetch-transcript CLI with the appropriate flags based on the user's request
2. Parse the transcript output
3. Present a structured analysis:
   - **Summary**: 2-3 sentence overview
   - **Action Items**: Bulleted list with owners
   - **Key Decisions**: What was decided
   - **Discussion Points**: Major topics covered
4. If the user asks for deeper analysis or research based on transcript content, use WebSearch and other tools

## Examples

- `/zoom-transcript` — pulls all of today's meeting transcripts
- `/zoom-transcript yesterday` — pulls yesterday's transcripts  
- `/zoom-transcript meeting-id 12345` — pulls a specific meeting

## Security

- NEVER display or log API credentials
- Credentials are read from `.env` by the CLI tool automatically
- Transcript content should be treated as confidential
