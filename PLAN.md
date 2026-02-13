# OpenZalo plugin migration plan (from legacy internal baseline)

## Goal
Create/ship `openzalo` from the legacy Zalo personal implementation while preserving compatibility, then add UX upgrades:
- send typing signal while generating replies
- send a user-visible error when dispatch fails, with optional opt-out and configurable text
- optional group "tag-only" reply mode

## Current status snapshot
- `openzalo` already mirrors the legacy listener/pipeline shape and merges top-level config into account config.
- Baseline compatibility points are intact: `openzalo` identity, `openzca` command paths, pairing/allowlist/group routing, text/media sends.
- Remaining hardening work is in `monitor`, `send`, `channel`, and config schema/types.

## Implementation plan
1) Typing signal during reply generation
- `src/send.ts`
  - add typed helper `sendTypingOpenzalo` that executes `openzca msg typing <threadId> [-g]`.
- `src/monitor.ts`
  - keep `createReplyDispatcherWithTyping` flow.
  - wire typing start to `sendTypingOpenzalo`.
  - keep typing logging failures via `logTypingFailure` without hard-failing dispatch.
  - preserve `markDispatchIdle` in `finally`.

2) Dispatch-failure visible fallback
- `src/monitor.ts`, `src/config-schema.ts`, `src/types.ts`
  - add optional config:
    - `sendFailureNotice?: boolean` (default behavior: enabled)
    - `sendFailureMessage?: string` (default user-friendly text)
  - if dispatch or delivery raises and no reply chunk was successfully sent, and `sendFailureNotice !== false`, send fallback text back via `sendMessageOpenzalo`.
  - if disabled, only internal logs/errors.

3) Group tag-only mode (configurable)
- `src/types.ts`
  - add `OpenzaloGroupConfig.requireMention?: boolean`.
  - add `OpenzaloAccountConfig.groupRequireMention?: boolean`.
  - add `sendFailureNotice`/`sendFailureMessage` to both account and channel-level config types.
- `src/config-schema.ts`
  - expose same fields with `z.boolean()` and `z.string()`.
- `src/channel.ts`
  - add `resolveOpenzaloGroupRequireMention({ cfg, accountId, groupId, groupChannel })`.
    - per-group config (`groups[groupId]`, `groups[groupChannel]`, then `groups[*]`)
    - fallback to `account.config.groupRequireMention`
    - fallback default `false` (compatible with existing legacy behavior)
  - use helper in both dock/plugin `groups.resolveRequireMention`.
- `src/monitor.ts`
  - require tag only when config resolves `true` and mention can be detected.
  - add `groupMentionDetectionFailure` (`allow | deny | allow-with-warning`) for when mention detection fails.
  - keep authorized control-command bypass as already implemented.

4) Final parity check + UX compare findings
- Re-check these related plugin behaviors before final release:
  - Telegram: explicit group mention resolver path.
  - Slack: `resolveRequireMention` + group policy/warning patterns.
  - Mattermost/Nextcloud/Matrix: control-command bypass + mention heuristics for group filtering.
  - MS Teams: user-visible `dispatch` failure text on handler catch.

## Target files
- `src/monitor.ts`
- `src/send.ts`
- `src/channel.ts`
- `src/config-schema.ts`
- `src/types.ts`
- `PLAN.md` (status tracking)
