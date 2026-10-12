// echo child for the IPC stress test: replies to {k:'echo'}, counts payload bytes for {k:'data'}, reports on {k:'report'}
let bytes = 0;
process.on('message', (m) => { if (m.k === 'echo') { process.send(m); } else if (m.k === 'data') { bytes += m.s.length; } else if (m.k === 'report') { process.send({ k: 'count', bytes }); } });
process.send({ k: 'ready' });
