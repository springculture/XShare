/* Minimal static server for XShare.
   Usage: node serve.js [port]   →   http://localhost:8080/?demo=1            */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.argv[2] || 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png'
};

http.createServer((req, res) => {
  let name = decodeURIComponent(req.url.split('?')[0]);
  if (name === '/' || name === '') name = '/index.html';
  const file = path.join(root, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => {
  console.log('XShare → http://localhost:' + port + '/?demo=1');
});
