const net = require('net');
const c = net.connect(Number(process.argv[2]), '127.0.0.1', () => c.end('from a forked quickjs client'));
let got = ''; c.on('data', d => got += d); c.on('end', () => console.log('child got echo:', got));
