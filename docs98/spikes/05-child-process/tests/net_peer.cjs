// plain Node.js client: proves the QuickJS server speaks real TCP to a different implementation
const net = require('net');
const c = net.connect(Number(process.argv[2]), '127.0.0.1', () => c.end('hello from real node'));
let got = ''; c.on('data', d => got += d); c.on('end', () => console.log('node peer got echo:', got));
