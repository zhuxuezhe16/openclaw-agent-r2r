/**
 * Plugin unit test — no OpenClaw Gateway required.
 * Mocks the OpenClawPluginApi and exercises all registered tools and gateway methods.
 *
 * Run: node plugins/agent-r2r/test.js
 */

'use strict';

const register = require('./index');

// ── Mock API ────────────────────────────────────────────────────────────────

const registeredTools = [];    // { factory, opts }
const gatewayMethods = {};     // { methodName: handler }
const hooks = {};              // { hookName: handler }

const mockLogger = {
  info:  (msg) => console.log(`  [LOG] ${msg}`),
  warn:  (msg) => console.warn(`  [WARN] ${msg}`),
  error: (msg) => console.error(`  [ERR] ${msg}`),
};

// Track heartbeat wake calls: [{ agentId, reason }]
const heartbeatWakes = [];

const mockApi = {
  id: 'agent-r2r',
  name: 'Agent R2R Capability',
  config: {},
  pluginConfig: { displayLayerEnabled: false },
  logger: mockLogger,
  runtime: {
    system: {
      requestHeartbeatNow(opts) {
        heartbeatWakes.push({ agentId: opts && opts.agentId, reason: opts && opts.reason });
      },
    },
  },
  registerTool(factory, opts) {
    registeredTools.push({ factory, opts });
  },
  registerGatewayMethod(method, handler) {
    gatewayMethods[method] = handler;
  },
  on(hookName, handler) {
    hooks[hookName] = handler;
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function mockGatewayCall(method, params) {
  return new Promise((resolve) => {
    const handler = gatewayMethods[method];
    if (!handler) {
      resolve({ ok: false, error: `method ${method} not found` });
      return;
    }
    handler({
      req: {},
      params: params || {},
      client: null,
      respond: (ok, payload, error) => resolve({ ok, payload, error }),
    });
  });
}

// ── Run plugin registration ──────────────────────────────────────────────────

console.log('\n=== agent-r2r plugin test ===\n');

console.log('1. Registration');
register(mockApi);

assert(registeredTools.length === 1, 'registerTool called once (factory)');
assert(typeof registeredTools[0].factory === 'function', 'tool factory is a function');
assert(
  JSON.stringify(registeredTools[0].opts?.names) === JSON.stringify(['send_r2r_message', 'receive_r2r_messages']),
  'tool names declared: send_r2r_message, receive_r2r_messages',
);
assert(typeof gatewayMethods['r2r.send'] === 'function', 'r2r.send gateway method registered');
assert(typeof gatewayMethods['r2r.status'] === 'function', 'r2r.status gateway method registered');
assert(typeof hooks['gateway_start'] === 'function', 'gateway_start hook registered');
assert(typeof hooks['gateway_stop'] === 'function', 'gateway_stop hook registered');
assert(typeof hooks['message_received'] === 'function', 'message_received hook registered');
assert(typeof hooks['before_prompt_build'] === 'function', 'before_prompt_build hook registered');

// ── Tool factory ─────────────────────────────────────────────────────────────

console.log('\n2. Tool factory');

const toolsA = registeredTools[0].factory({ agentId: 'agentA' });
const toolsB = registeredTools[0].factory({ agentId: 'agentB' });
const sendTool = toolsA.find(t => t.name === 'send_r2r_message');
const recvToolB = toolsB.find(t => t.name === 'receive_r2r_messages');

// Adapter: call execute(toolCallId, params) and unwrap AgentToolResult -> details
function callTool(tool, params) {
  return tool.execute('test-call-id', params || {}).then(r => r.details);
}

assert(Array.isArray(toolsA) && toolsA.length === 2, 'factory returns 2 tools');
assert(!!sendTool, 'send_r2r_message tool present');
assert(!!recvToolB, 'receive_r2r_messages tool present (agentB)');
assert(sendTool.parameters.type === 'object', 'send tool has JSON schema');
assert(Array.isArray(sendTool.parameters.required), 'send tool has required fields');

// ── send_r2r_message ─────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n3. send_r2r_message (agentA -> agentB)');

  const result = await callTool(sendTool, {
    toAgent: 'agentB',
    themeId: 'task_001',
    themeTitle: '测试任务',
    purpose: 'request',
    content: '请执行数据汇总',
    notifyUser: false,
  });

  assert(result.ok === true, 'send returns ok:true');
  assert(typeof result.messageId === 'string' && result.messageId.length > 0, 'send returns messageId');
  assert(typeof result.timestamp === 'string', 'send returns timestamp');

  // ── receive_r2r_messages ───────────────────────────────────────────────────

  console.log('\n4. receive_r2r_messages (agentB dequeues)');

  const recv = await callTool(recvToolB, { maxMessages: 10 });

  assert(Array.isArray(recv.messages), 'receive returns messages array');
  assert(recv.messages.length === 1, 'agentB has 1 pending message');
  assert(recv.messages[0].body.purpose === 'request', 'message purpose is request');
  assert(recv.messages[0].header.fromAgent === 'agentA', 'fromAgent is agentA');
  assert(recv.messages[0].body.content === '请执行数据汇总', 'content preserved');
  assert(recv.pending === 0, 'no more pending after dequeue');

  // ── auto-ACK check ─────────────────────────────────────────────────────────

  console.log('\n5. Auto-ACK (agentA receives ack after agentB dequeues)');

  const recvToolA = toolsA.find(t => t.name === 'receive_r2r_messages');
  const ackResult = await callTool(recvToolA, {});

  assert(ackResult.messages.length === 1, 'agentA has 1 auto-ACK message');
  assert(ackResult.messages[0].body.purpose === 'ack', 'auto-ACK purpose is ack');
  assert(ackResult.messages[0].header.fromAgent === 'agentB', 'ACK from agentB');

  // ── empty queue ────────────────────────────────────────────────────────────

  console.log('\n6. Empty queue');

  const empty = await callTool(recvToolB, {});
  assert(empty.messages.length === 0, 'empty queue returns 0 messages');
  assert(empty.pending === 0, 'pending is 0');

  // ── r2r.status gateway method ──────────────────────────────────────────────

  console.log('\n7. r2r.status gateway method');

  // Send another message to create a queue entry
  await callTool(sendTool, {
    toAgent: 'agentC',
    themeId: 'task_002',
    purpose: 'request',
    content: 'hello agentC',
  });

  const status = await mockGatewayCall('r2r.status');
  assert(status.ok === true, 'r2r.status ok:true');
  assert(typeof status.payload.pendingQueues === 'object', 'pendingQueues object present');
  assert(status.payload.pendingQueues['agentC'] === 1, 'agentC has 1 pending');
  assert(status.payload.totalPending === 1, 'totalPending is 1');

  // ── r2r.send gateway method ────────────────────────────────────────────────

  console.log('\n8. r2r.send gateway method (external injection)');

  const sendResult = await mockGatewayCall('r2r.send', {
    toAgent: 'agentB',
    fromAgent: 'external-system',
    body: { themeId: 'task_003', purpose: 'request', content: '来自外部系统的任务' },
    metadata: { notifyUser: false },
  });

  assert(sendResult.ok === true, 'r2r.send returns ok');
  assert(typeof sendResult.payload.messageId === 'string', 'r2r.send returns messageId');

  const afterInject = await callTool(recvToolB, {});
  assert(afterInject.messages.length === 1, 'agentB received the injected message');
  assert(afterInject.messages[0].header.fromAgent === 'external-system', 'fromAgent is external-system');

  // ── r2r.send error case ────────────────────────────────────────────────────

  console.log('\n9. r2r.send error handling');

  const badResult = await mockGatewayCall('r2r.send', { toAgent: 'agentB' }); // missing body
  assert(badResult.ok === false, 'r2r.send returns ok:false when body missing');
  assert(typeof badResult.error?.message === 'string', 'error message present');

  // ── cross-channel JSON injection ───────────────────────────────────────────

  console.log('\n10. Cross-channel R2R injection (message_received hook)');

  hooks['message_received'](
    {
      from: 'whatsapp-user-123',
      content: JSON.stringify({
        r2r: {
          toAgent: 'agentB',
          body: { themeId: 'task_004', purpose: 'request', content: 'WhatsApp 注入消息' },
        },
      }),
    },
    { channelId: 'whatsapp' },
  );

  const afterChannel = await callTool(recvToolB, {});
  assert(afterChannel.messages.length === 1, 'agentB received channel-injected R2R message');
  assert(afterChannel.messages[0].body.content === 'WhatsApp 注入消息', 'content preserved from channel');
  assert(afterChannel.messages[0].metadata.fromChannel === 'whatsapp', 'fromChannel tagged');

  // ── gateway_stop clears queues ────────────────────────────────────────────

  console.log('\n11. gateway_stop clears all queues');

  await callTool(sendTool, { toAgent: 'agentB', themeId: 't', purpose: 'request', content: 'x' });
  hooks['gateway_stop']({ reason: 'test' });

  const afterStop = await callTool(recvToolB, {});
  assert(afterStop.messages.length === 0, 'queues cleared after gateway_stop');

  // ── before_prompt_build push delivery ────────────────────────────────────

  console.log('\n12. before_prompt_build auto-delivers pending R2R messages');

  // Send a message to agentB
  await callTool(sendTool, {
    toAgent: 'agentB',
    themeId: 'push_001',
    purpose: 'request',
    content: '请处理这个推送任务',
  });

  // Simulate agentB being triggered — hook fires before prompt build
  const pushResult = hooks['before_prompt_build']({}, { agentId: 'agentB' });
  assert(typeof pushResult === 'object' && pushResult !== null, 'hook returns result object');
  assert(typeof pushResult.prependContext === 'string', 'prependContext is a string');
  assert(pushResult.prependContext.includes('push_001') || pushResult.prependContext.includes('请处理'), 'context contains message content');

  // Queue should be empty after push delivery
  const afterPush = await callTool(recvToolB, {});
  assert(afterPush.messages.length === 0, 'queue empty after push delivery');

  // agentA should have received auto-ACK
  const recvToolA2 = toolsA.find(t => t.name === 'receive_r2r_messages');
  const ackAfterPush = await callTool(recvToolA2, {});
  assert(ackAfterPush.messages.length === 1, 'agentA got auto-ACK from push delivery');
  assert(ackAfterPush.messages[0].body.purpose === 'ack', 'auto-ACK purpose correct');

  // No pending messages → hook returns nothing
  const noResult = hooks['before_prompt_build']({}, { agentId: 'agentB' });
  assert(noResult === undefined || noResult === null || !noResult, 'hook returns nothing when queue empty');

  // ── heartbeat wake on enqueue ─────────────────────────────────────────────

  console.log('\n13. requestHeartbeatNow called when message enqueued');

  const wakesBefore = heartbeatWakes.length;
  await callTool(sendTool, {
    toAgent: 'agentD',
    themeId: 'wake_test',
    purpose: 'request',
    content: '测试心跳唤醒',
  });
  const wakesAfter = heartbeatWakes.length;
  assert(wakesAfter > wakesBefore, 'heartbeat wake requested after send');
  const lastWake = heartbeatWakes[heartbeatWakes.length - 1];
  assert(lastWake.agentId === 'agentD', 'wake targets the correct agent (agentD)');
  assert(lastWake.reason === 'r2r:incoming', 'wake reason is r2r:incoming');

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
