console.log('child argv', JSON.stringify(process.argv.slice(2)), 'connected', process.connected, 'typeof send', typeof process.send);
console.error('child stderr line');
process.send({ type: 'hello', pid: process.pid, ppidIsParent: true });
process.on('message', (m) => {
	if (m.type === 'ping') { process.send({ type: 'pong', n: m.n, len: m.payload.length }); }
	else if (m.type === 'bye') { process.disconnect(); }
});
process.on('disconnect', () => { console.log('child: disconnect, exiting 5'); process.exit(5); });
