const EventEmitter = require('events');
const gateway = new EventEmitter();
gateway.agents = [ { name: 'agentA' }, { name: 'agentB' } ];

const install = require('./index');
install(gateway);
gateway.on('r2r:display', msg => console.log('[DISPLAY]', msg.header.messageId, msg.body.content));

gateway.emit('onAgentsLoaded');

const a = gateway.agents[0];
const b = gateway.agents[1];

b.listen(msg => {
  console.log('agentB received:', msg.body.content, 'purpose=', msg.body.purpose);
});

// send a request from A -> B
const sent = a.sendR2R('agentB', { themeId: 'task_001', themeTitle: 'Test', purpose: 'request', content: '请执行动作' }, { notifyUser: true });
console.log('A sent', sent.header.messageId);
