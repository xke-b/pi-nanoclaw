---
name: add-feishu
description: Add Feishu CN as a channel. Runs in parallel with Telegram/WhatsApp using a minimal text-only MVP implementation.
---

# Add Feishu Channel (CN, MVP)

This skill adds **Feishu CN** channel support to NanoClaw with Telegram-level complexity.

## Scope

### Included
- Feishu CN only (`open.feishu.cn`)
- WebSocket long-connection mode
- Text inbound/outbound
- Group + DM handling
- Basic mention-to-trigger normalization in groups

### Not included (MVP)
- Lark global
- Webhook mode
- Cards/media/reactions/threads
- Multi-account routing

## Phase 1: Pre-flight

1. Read `.nanoclaw/state.yaml`.
2. If `feishu` is already applied, skip to setup/verification.
3. Ask user if they already have Feishu app credentials (`App ID`, `App Secret`).

## Phase 2: Apply Code Changes

Initialize skills system if needed:

```bash
npx tsx scripts/apply-skill.ts --init
```

Apply skill:

```bash
npx tsx scripts/apply-skill.ts .pi/skills/add-feishu
```

This applies:
- `src/channels/feishu.ts`
- `src/channels/feishu.test.ts`
- `src/channels/index.ts` import update
- npm dependency `@larksuiteoapi/node-sdk`
- `.env.example` additions (`FEISHU_APP_ID`, `FEISHU_APP_SECRET`)

Validate:

```bash
npm run build
npm test
```

## Phase 3: Feishu CN App Setup

In Feishu Open Platform (`https://open.feishu.cn/app`):

1. Create enterprise app
2. Enable Bot capability
3. Enable Event Subscription using **long connection (WebSocket)**
4. Add event: `im.message.receive_v1`
5. Publish app version

Collect:
- `FEISHU_APP_ID` (e.g. `cli_xxx`)
- `FEISHU_APP_SECRET`

## Phase 4: Configure NanoClaw

Set env vars in `.env`:

```bash
FEISHU_APP_ID=<your-app-id>
FEISHU_APP_SECRET=<your-app-secret>
```

Sync container env snapshot:

```bash
mkdir -p data/env && cp .env data/env/env
```

Rebuild and restart:

```bash
npm run build
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux
# systemctl --user restart nanoclaw
```

## Phase 5: Register Feishu Chat

Use Feishu `chat_id` and register as `fs:<chat_id>`.

Main/control chat example:

```typescript
registerGroup('fs:<chat_id>', {
  name: 'Feishu Main',
  folder: 'feishu_main',
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

Additional group (trigger-required):

```typescript
registerGroup('fs:<chat_id>', {
  name: 'Feishu Group',
  folder: 'feishu_group',
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 6: Verify

1. Send a DM message to bot
2. Send a group message with bot mention
3. Confirm response and check logs:

```bash
tail -f logs/nanoclaw.log
```

Expected:
- `Feishu bot connected`
- `Feishu message stored`
- outbound message sent

## Troubleshooting

- Missing credentials: verify `.env` and `data/env/env`
- No response in groups: ensure bot is in group and mention bot for trigger-required groups
- No events: verify app published and event `im.message.receive_v1` is enabled

## Removal

1. Remove `src/channels/feishu.ts` and `src/channels/feishu.test.ts`
2. Remove `import './feishu.js'` from `src/channels/index.ts`
3. Remove `FEISHU_APP_ID`/`FEISHU_APP_SECRET` from `.env`
4. Uninstall dependency:

```bash
npm uninstall @larksuiteoapi/node-sdk
```
