/**
 * Agent R2R Capability Plugin
 * OpenClaw Plugin SDK implementation.
 *
 * Registers:
 *   - send_r2r_message tool: agent sends a structured R2R message to another agent
 *   - receive_r2r_messages tool: agent polls its inbound R2R queue
 *   - r2r.send gateway method: external/channel injection of R2R messages
 *   - r2r.status gateway method: diagnostics (pending queue sizes)
 *
 * Message format follows requirements.md R2R spec:
 *   { header: { messageId, fromAgent, toAgent, timestamp, priority },
 *     body: { themeId, themeTitle, purpose, content, deliverables },
 *     metadata: { contextId, tags, notifyUser } }
 *
 * Cross-channel injection: if an inbound channel message is valid JSON containing
 * a top-level "r2r" key, it is parsed and routed into the R2R bus automatically.
 */

'use strict';

const { EventEmitter } = require('events');

// Shared in-memory R2R bus for this plugin instance.
const r2rBus = new EventEmitter();
r2rBus.setMaxListeners(200);

// Per-agent inbound queues: Map<agentId, R2RMessage[]>
const pendingQueues = new Map();

// Set during plugin registration; used to wake the target agent's heartbeat.
let _requestHeartbeatNow = null;

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function buildMessage({ fromAgent, toAgent, body, metadata }) {
  return {
    header: {
      messageId: generateUUID(),
      fromAgent: fromAgent || 'unknown',
      toAgent,
      timestamp: new Date().toISOString(),
      priority: (metadata && metadata.priority) || 'normal',
    },
    body: {
      themeId: body.themeId || 'default',
      themeTitle: body.themeTitle || body.themeId || 'default',
      purpose: body.purpose || 'request',
      content: body.content || '',
      deliverables: body.deliverables || [],
    },
    metadata: {
      contextId: metadata && metadata.contextId,
      tags: (metadata && metadata.tags) || [],
      notifyUser: !!(metadata && metadata.notifyUser),
      ...(metadata || {}),
    },
  };
}

function enqueue(toAgent, msg) {
  if (!pendingQueues.has(toAgent)) {
    pendingQueues.set(toAgent, []);
  }
  pendingQueues.get(toAgent).push(msg);
  r2rBus.emit('r2r:message', msg);
  // Wake the target agent's heartbeat immediately so it processes the message
  // without waiting for a scheduled cron tick.
  if (_requestHeartbeatNow) {
    _requestHeartbeatNow({ agentId: toAgent, reason: 'r2r:incoming' });
  }
}

// Tool factory: called per-session with agent context.
// Returns two tools for the agent: send and receive.
function createR2RTools(agentId, logger) {
  const sendTool = {
    label: 'Send R2R Message',
    name: 'send_r2r_message',
    description:
      'Send a structured R2R (Robot-to-Robot) message to another agent. ' +
      'Use this to delegate tasks, request information, or coordinate with other agents. ' +
      'The message is queued for the target agent and auto-ACKed on receipt.',
    parameters: {
      type: 'object',
      properties: {
        toAgent: {
          type: 'string',
          description: 'Target agent ID',
        },
        themeId: {
          type: 'string',
          description: 'Topic/thread identifier (e.g. "task_001")',
        },
        themeTitle: {
          type: 'string',
          description: 'Human-readable topic title',
        },
        purpose: {
          type: 'string',
          enum: ['request', 'response', 'ack'],
          description: 'Message purpose: request, response, or ack',
        },
        content: {
          type: 'string',
          description: 'Main message content',
        },
        notifyUser: {
          type: 'boolean',
          description: 'Surface this message in the channel display layer (default: false)',
        },
        contextId: {
          type: 'string',
          description: 'Optional conversation/context ID to group related messages',
        },
      },
      required: ['toAgent', 'themeId', 'purpose', 'content'],
    },
    execute: async (_toolCallId, input) => {
      const msg = buildMessage({
        fromAgent: agentId,
        toAgent: input.toAgent,
        body: {
          themeId: input.themeId,
          themeTitle: input.themeTitle,
          purpose: input.purpose,
          content: input.content,
        },
        metadata: {
          notifyUser: input.notifyUser === true,
          contextId: input.contextId,
        },
      });
      enqueue(input.toAgent, msg);
      logger.info(
        `[agent-r2r] ${agentId} -> ${input.toAgent} [${input.purpose}]: ${input.content.slice(0, 80)}`,
      );
      const result = { ok: true, messageId: msg.header.messageId, timestamp: msg.header.timestamp };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };

  const receiveTool = {
    label: 'Receive R2R Messages',
    name: 'receive_r2r_messages',
    description:
      'Dequeue and return pending R2R messages sent to this agent. ' +
      'Returns up to maxMessages at once and auto-ACKs any "request" messages.',
    parameters: {
      type: 'object',
      properties: {
        maxMessages: {
          type: 'number',
          description: 'Max messages to dequeue (default: 10)',
        },
      },
      required: [],
    },
    execute: async (_toolCallId, input) => {
      const queue = pendingQueues.get(agentId);
      if (!queue || queue.length === 0) {
        const result = { messages: [], pending: 0 };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      }
      const limit = (input && input.maxMessages) || 10;
      const messages = queue.splice(0, limit);
      if (queue.length === 0) pendingQueues.delete(agentId);

      // Auto-ACK any request-purpose messages
      for (const msg of messages) {
        if (msg.body.purpose === 'request') {
          const ack = buildMessage({
            fromAgent: agentId,
            toAgent: msg.header.fromAgent,
            body: {
              themeId: msg.body.themeId,
              themeTitle: msg.body.themeTitle,
              purpose: 'ack',
              content: `ACK:${msg.header.messageId}`,
            },
            metadata: { notifyUser: false, contextId: msg.metadata.contextId },
          });
          enqueue(msg.header.fromAgent, ack);
        }
      }

      logger.info(`[agent-r2r] ${agentId} dequeued ${messages.length} message(s)`);
      const remaining = pendingQueues.get(agentId);
      const result = { messages, pending: remaining ? remaining.length : 0 };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };

  return [sendTool, receiveTool];
}

// Main plugin registration function — called by the OpenClaw plugin loader.
module.exports = function register(api) {
  const logger = api.logger;
  const pluginConfig = api.pluginConfig || {};
  const defaultNotifyUser = pluginConfig.displayLayerEnabled === true;

  // Capture heartbeat wake function so enqueue() can immediately trigger the
  // target agent's LLM run when a new R2R message arrives.
  _requestHeartbeatNow = api.runtime.system.requestHeartbeatNow;

  logger.info('[agent-r2r] registering plugin');

  // Register tools via factory so each session/agent gets its own agentId binding.
  api.registerTool(
    (ctx) => {
      const agentId = ctx.agentId || 'unknown';
      return createR2RTools(agentId, logger);
    },
    { names: ['send_r2r_message', 'receive_r2r_messages'] },
  );

  // Gateway method: r2r.send — allows external callers (e.g. channel adapters, tests)
  // to inject R2R messages directly into an agent's queue.
  // Request params: { fromAgent?, toAgent, body: { themeId, purpose, content, ... }, metadata? }
  api.registerGatewayMethod('r2r.send', ({ params, respond }) => {
    const p = params || {};
    if (!p.toAgent || !p.body) {
      respond(false, null, { message: 'toAgent and body are required', code: 400 });
      return;
    }
    const msg = buildMessage({
      fromAgent: p.fromAgent || 'external',
      toAgent: p.toAgent,
      body: p.body,
      metadata: { notifyUser: defaultNotifyUser, ...(p.metadata || {}) },
    });
    enqueue(p.toAgent, msg);
    logger.info(`[agent-r2r] r2r.send -> ${p.toAgent}: ${String(p.body.content).slice(0, 80)}`);
    respond(true, { ok: true, messageId: msg.header.messageId });
  });

  // Gateway method: r2r.status — returns pending queue sizes for diagnostics.
  api.registerGatewayMethod('r2r.status', ({ respond }) => {
    const queues = {};
    let total = 0;
    for (const [agentId, queue] of pendingQueues.entries()) {
      queues[agentId] = queue.length;
      total += queue.length;
    }
    respond(true, { ok: true, pendingQueues: queues, totalPending: total });
  });

  // Lifecycle: clear queues on gateway stop to avoid stale state across restarts.
  api.on('gateway_stop', () => {
    logger.info('[agent-r2r] gateway stopping, clearing R2R queues');
    pendingQueues.clear();
  });

  api.on('gateway_start', (event) => {
    logger.info(`[agent-r2r] gateway started on port ${event.port}`);
  });

  // Push delivery: before each agent run, dequeue any pending R2R messages and
  // inject them as prependContext so the agent sees and acts on them automatically.
  api.on('before_prompt_build', (_event, ctx) => {
    const agentId = ctx.agentId;
    if (!agentId) return;

    const queue = pendingQueues.get(agentId);
    if (!queue || queue.length === 0) return;

    // Dequeue up to 10 messages (same default as the tool).
    const messages = queue.splice(0, 10);
    if (queue.length === 0) pendingQueues.delete(agentId);

    // Auto-ACK any request-purpose messages (same logic as the tool).
    for (const msg of messages) {
      if (msg.body.purpose === 'request') {
        const ack = buildMessage({
          fromAgent: agentId,
          toAgent: msg.header.fromAgent,
          body: {
            themeId: msg.body.themeId,
            themeTitle: msg.body.themeTitle,
            purpose: 'ack',
            content: `ACK:${msg.header.messageId}`,
          },
          metadata: { notifyUser: false, contextId: msg.metadata.contextId },
        });
        enqueue(msg.header.fromAgent, ack);
      }
    }

    logger.info(`[agent-r2r] push-delivered ${messages.length} R2R message(s) to ${agentId}`);

    // Format messages as readable context for the agent.
    const lines = [
      `[R2R] 你收到 ${messages.length} 条来自其他 Agent 的消息，请处理后再回复用户：`,
      '',
    ];
    for (const msg of messages) {
      lines.push(
        `--- 消息 ${msg.header.messageId.slice(0, 8)} ---`,
        `发件人: ${msg.header.fromAgent}`,
        `主题: ${msg.body.themeTitle || msg.body.themeId}`,
        `类型: ${msg.body.purpose}`,
        `内容: ${msg.body.content}`,
        '',
      );
    }

    return { prependContext: lines.join('\n') };
  });

  // Cross-channel R2R injection: if an inbound channel message is valid JSON with
  // a top-level "r2r" key, parse and route it into the R2R bus.
  // This enables WhatsApp/Telegram/etc. -> Gateway -> Agent R2R flows.
  api.on('message_received', (event, ctx) => {
    const content = event.content;
    if (typeof content !== 'string' || !content.startsWith('{')) return;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return;
    }
    const r2r = parsed.r2r;
    if (!r2r || !r2r.toAgent || !r2r.body) return;
    const msg = buildMessage({
      fromAgent: r2r.fromAgent || ctx.channelId || 'channel',
      toAgent: r2r.toAgent,
      body: r2r.body,
      metadata: { ...(r2r.metadata || {}), fromChannel: ctx.channelId },
    });
    enqueue(r2r.toAgent, msg);
    logger.info(
      `[agent-r2r] channel ${ctx.channelId} -> ${r2r.toAgent} via R2R injection`,
    );
  });

  logger.info(
    '[agent-r2r] ready: tools=[send_r2r_message, receive_r2r_messages], ' +
      'gateway=[r2r.send, r2r.status]',
  );
};
