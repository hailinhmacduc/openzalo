# @openclaw/openzalo

OpenClaw extension for Zalo Personal Account messaging via [openzca](https://openzca.com/).

> **Warning:** Using Zalo automation may result in account suspension or ban. Use at your own risk. This is an unofficial integration.

## Features

- **Channel Plugin Integration**: Appears in onboarding wizard with QR login
- **Gateway Integration**: Real-time message listening via the gateway
- **Multi-Account Support**: Manage multiple Zalo personal accounts
- **CLI Commands**: Full command-line interface for messaging
- **Agent Tool**: AI agent integration for automated messaging

## Prerequisites

Install `openzca` and ensure it's in your PATH:

**macOS / Linux:**

```bash
npm i -g openzca

# Or install via official installer script
curl -fsSL https://openzca.com/install.sh | bash
```

**Windows (PowerShell):**

```powershell
# Install via official installer script
irm https://openzca.com/install.ps1 | iex
```

### Run without install

```bash
npx openzca --help
```

See [openzca docs](https://openzca.com/) for installation and usage details.

## Quick Start

### Option 1: Onboarding Wizard (Recommended)

```bash
openclaw onboard
# Select "Zalo Personal" from channel list
# Follow QR code login flow
```

### Option 2: Login (QR, on the Gateway machine)

```bash
openclaw channels login --channel openzalo
# Scan QR code with Zalo app
```

### Send a Message

```bash
openclaw message send --channel openzalo --target <threadId> --message "Hello from OpenClaw!"
```

## Configuration

After onboarding, your config will include:

```yaml
channels:
  openzalo:
    enabled: true
    dmPolicy: pairing # pairing | allowlist | open | disabled
    groupRequireMention: true # require @mention in group chats
    groupMentionDetectionFailure: deny # allow | deny | allow-with-warning
    sendFailureNotice: true # send fallback message on dispatch failure
    sendFailureMessage: Some problem occurred, could not send a reply.
```

For multi-account:

```yaml
channels:
  openzalo:
    enabled: true
    defaultAccount: default
    accounts:
      default:
        enabled: true
        profile: default
      work:
        enabled: true
        profile: work
```

## Commands

### Authentication

```bash
openclaw channels login --channel openzalo              # Login via QR
openclaw channels login --channel openzalo --account work
openclaw channels status --probe
openclaw channels logout --channel openzalo
```

### Directory (IDs, contacts, groups)

```bash
openclaw directory self --channel openzalo
openclaw directory peers list --channel openzalo --query "name"
openclaw directory groups list --channel openzalo --query "work"
openclaw directory groups members --channel openzalo --group-id <id>
```

### Account Management

```bash
openzca account list      # List all profiles
openzca account current   # Show active profile
openzca account switch <profile>
openzca account remove <profile>
openzca account label <profile> "Work Account"
```

### Messaging

```bash
# Text
openclaw message send --channel openzalo --target <threadId> --message "message"

# Media (URL)
openclaw message send --channel openzalo --target <threadId> --message "caption" --media-url "https://example.com/img.jpg"
```

### Listener

The listener runs inside the Gateway when the channel is enabled. For debugging,
use `openclaw channels logs --channel openzalo` or run `openzca listen` directly.

### Data Access

```bash
# Friends
openzca friend list
openzca friend list -j    # JSON output
openzca friend find "name"
openzca friend online

# Groups
openzca group list
openzca group info <groupId>
openzca group members <groupId>

# Profile
openzca me info
openzca me id
```

## Multi-Account Support

Use `--profile` or `-p` to work with multiple accounts:

```bash
openclaw channels login --channel openzalo --account work
openclaw message send --channel openzalo --account work --target <id> --message "Hello"
openzca --profile work listen
```

Profile resolution order: CLI `--profile` flag > default profile.

## Agent Tool

The extension registers a `openzalo` tool for AI agents:

```json
{
  "action": "send",
  "threadId": "123456",
  "message": "Hello from AI!",
  "isGroup": false,
  "profile": "default"
}
```

Available actions: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`

## Troubleshooting

- **Login Issues:** Run `openzca auth logout` then `openzca auth login`
- **API Errors:** Try `openzca auth cache-refresh` or re-login
- **File Uploads:** Check size (max 100MB) and path accessibility

## Credits

Built on [openzca](https://openzca.com/) which uses [zca-js](https://github.com/RFS-ADRENO/zca-js).
