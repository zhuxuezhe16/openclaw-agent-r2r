# Integration Notes

## Status: Integrated

The plugin now uses the real OpenClaw Plugin SDK (`OpenClawPluginApi`). The previous
EventEmitter-based prototype has been replaced with a proper SDK implementation.

## Files

| File | Purpose |
|---|---|
| `openclaw.plugin.json` | Required manifest: plugin `id`, `configSchema`, metadata |
| `index.js` | Plugin entry — exports `register(api)` |
| `package.json` | npm metadata |
| `example.js` | Standalone EventEmitter demo (no Gateway needed) |
| `README.md` | Installation and usage guide |

## Plugin SDK API used

| API | Purpose |
|---|---|
| `api.registerTool(factory, { names })` | Register `send_r2r_message` + `receive_r2r_messages` tools via context-aware factory |
| `api.registerGatewayMethod('r2r.send', handler)` | External R2R message injection |
| `api.registerGatewayMethod('r2r.status', handler)` | Diagnostics endpoint |
| `api.on('gateway_start', handler)` | Log gateway port on startup |
| `api.on('gateway_stop', handler)` | Clear in-memory queues on shutdown |
| `api.on('message_received', handler)` | Auto-parse cross-channel R2R JSON payloads |

## How the plugin loads

1. Gateway calls `loadOpenClawPlugins()` on startup.
2. The loader reads `openclaw.plugin.json` to get the plugin `id` and validate `configSchema`.
3. The loader requires `index.js` via Jiti and calls `register(api)`.
4. All tools, gateway methods, and hooks are wired in at that point.
5. Every agent session gets `send_r2r_message` + `receive_r2r_messages` injected via the tool factory.

## Installation

```bash
openclaw plugins install -l ./plugins/agent-r2r
openclaw plugins enable agent-r2r
```

The `-l` flag (link) adds the directory to `plugins.load.paths` without copying files.

## Gateway method handler signature

Handlers receive `{ req, params, client, respond }` and must call `respond(ok, payload?, error?)`:

```js
api.registerGatewayMethod('r2r.send', ({ params, respond }) => {
  // params is the JSON-decoded request params object
  respond(true, { ok: true, messageId: '...' });
  // or on error:
  respond(false, null, { message: 'bad request', code: 400 });
});
```

## Tool factory signature

When passing a factory function instead of a tool object, it receives `OpenClawPluginToolContext`
and must return one or more tools (or null):

```js
api.registerTool(
  (ctx) => {
    // ctx.agentId, ctx.sessionKey, ctx.agentDir, ctx.config, ...
    return [toolA, toolB];
  },
  { names: ['toolA', 'toolB'] }
);
```

## In-memory message bus

Messages are stored in a `Map<agentId, R2RMessage[]>` (in-process, per Gateway lifetime).
On `gateway_stop` the queues are cleared. For persistence across restarts, the `start` hook
of a `registerService` could be used to write/read from disk — this is a future enhancement
if required.
