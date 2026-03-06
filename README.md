# Agent R2R Capability Plugin

Implements the [Agent R2R requirements](../../requirements.md) using the real OpenClaw Plugin SDK.

## What it provides

| Surface | Name | Description |
|---|---|---|
| Agent tool | `send_r2r_message` | Send a structured R2R message to another agent |
| Agent tool | `receive_r2r_messages` | Dequeue pending inbound R2R messages |
| Gateway method | `r2r.send` | External/channel injection of R2R messages |
| Gateway method | `r2r.status` | Diagnostics — pending queue sizes per agent |

## Installation

```bash
# Link the local plugin directory (adds to plugins.load.paths)
openclaw plugins install -l ./plugins/agent-r2r

# Enable it
openclaw plugins enable agent-r2r
```

Or add to `~/.openclaw/config.yaml`:

```yaml
plugins:
  enabled: true
  allow:
    - agent-r2r
  load:
    paths:
      - /path/to/plugins/agent-r2r
  entries:
    agent-r2r:
      enabled: true
```

## Configuration

Optional fields in `plugins.entries.agent-r2r.config`:

| Key | Type | Default | Description |
|---|---|---|---|
| `displayLayerEnabled` | boolean | `false` | Default `notifyUser` value for R2R messages |

## Agent usage

Once enabled, every agent automatically gets the two tools. Agents call them via normal tool use:

**Sending a message:**
```
send_r2r_message(
  toAgent="agentB",
  themeId="task_001",
  purpose="request",
  content="Please summarize the latest sales report",
  notifyUser=false
)
```

**Receiving messages:**
```
receive_r2r_messages(maxMessages=5)
```

## Cross-channel injection

Send an inbound channel message containing JSON with an `"r2r"` key to route it into the bus:

```json
{
  "r2r": {
    "toAgent": "agentB",
    "fromAgent": "whatsapp-user-123",
    "body": {
      "themeId": "task_001",
      "purpose": "request",
      "content": "Hello from WhatsApp"
    }
  }
}
```

## R2R message format

```json
{
  "header": {
    "messageId": "<uuid>",
    "fromAgent": "agentA",
    "toAgent": "agentB",
    "timestamp": "<ISO8601>",
    "priority": "normal"
  },
  "body": {
    "themeId": "task_001",
    "themeTitle": "Sales Report",
    "purpose": "request",
    "content": "Please summarize...",
    "deliverables": []
  },
  "metadata": {
    "contextId": null,
    "tags": [],
    "notifyUser": false
  }
}
```

## Standalone demo (no Gateway)

`example.js` is a self-contained EventEmitter demo for development/testing without needing a running Gateway:

```bash
node plugins/agent-r2r/example.js
```
