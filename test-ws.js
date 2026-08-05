const WebSocket = require('ws');

const serverId = '46ae9bb5-419f-4984-a1f2-e1050cd8edaf';
const containerId = 'mc-server-46ae9bb5-419f-4984-a1f2-e1050cd8edaf';
const apiKey = 'Demongrr';

const ws = new WebSocket(`ws://192.168.50.220:3500/api/v1/servers/${serverId}/console?containerId=${containerId}`);

ws.on('open', () => {
  console.log('Connected directly to daemon');
  ws.send(JSON.stringify({ auth: apiKey }));
});

ws.on('message', (data) => {
  console.log('Message from daemon:', data.toString());
});

ws.on('error', (err) => {
  console.error('Error:', err);
});

ws.on('close', (code, reason) => {
  console.log('Closed:', code, reason.toString());
});
