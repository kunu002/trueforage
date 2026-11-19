import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const media = fileURLToPath(new URL('../media/', import.meta.url));
const port = Number(process.env.TRUEFORAGE_PREVIEW_PORT || 4319);
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (pathname === '/' || pathname === '/preview') {
      const body = await readFile(path.join(media, 'panel.html'), 'utf8');
      response.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self';"});
      response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TrueForage · Playground</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/panel.css"></head><body>' + body + '<script src="/panel.js"></script></body></html>');
      return;
    }
    const types = {'/panel.css':'text/css','/panel.js':'text/javascript','/icon.svg':'image/svg+xml'};
    if (!types[pathname]) { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, {'Content-Type':types[pathname], 'Cache-Control':'no-store'});
    response.end(await readFile(path.join(media, pathname.slice(1))));
  } catch {
    response.writeHead(500);
    response.end('Preview unavailable');
  }
});
server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {signal:AbortSignal.timeout(2000)});
      const body = await response.text();
      if (response.ok && body.includes('TrueForage')) {
        process.stdout.write(`TrueForage preview is already running: http://127.0.0.1:${port}\n`);
        return;
      }
    } catch {}
  }
  process.stderr.write(`Preview could not start: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`TrueForage Playground preview: http://127.0.0.1:${port}\nFixed sample data. No model calls or repository edits.\n`));
