import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalRuntime, supportsTrueForgeNode } from '../src/runtime';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function freePort(): Promise<number> {
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  return port;
}

async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const childPrelude = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]);
const storage = path.dirname(process.env.SQLITE_PATH);
fs.appendFileSync(path.join(storage, 'launches.log'), String(process.pid) + '\\n');
fs.writeFileSync(path.join(storage, 'launch.json'), JSON.stringify({
  pid: process.pid, argv, host: process.env.HOST, sqlite: process.env.SQLITE_PATH,
  cache: process.env.npm_config_cache, allowed: JSON.parse(process.env.OUTBOUND_URL_ALLOWED_HOSTS),
  path: process.env.PATH, cwd: process.cwd()
}));
`;

const servingChild = `${childPrelude}
console.log('api_key=fixture-secret authorization=fixture-auth');
const server = http.createServer((_req, res) => { res.writeHead(401).end('authentication required'); });
server.listen(port, process.env.HOST);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

test('Node version compatibility accepts the supported minimum and rejects old or ambiguous executables', () => {
  for (const version of ['v22.14.0', '22.20.0', 'v24.1.0', 'v26.0.1']) assert.equal(supportsTrueForgeNode(version), true);
  for (const version of ['v22.13.9', 'v20.19.0', 'Electron 38.0.0', 'v22.14.0-rc.1', 'garbage']) assert.equal(supportsTrueForgeNode(version), false);
});

test('an existing authenticated server is reused and never stopped or written to by the manager', async (t) => {
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'trueforage-runtime-reuse-'));
  const server = createServer((_req, res) => res.writeHead(401).end('sign in'));
  const port = await listen(server);
  const storage = path.join(scratch, 'unused-storage');
  const runtime = new LocalRuntime({ extensionPath: scratch, storagePath: storage, nodePath: '/missing/node' });
  t.after(async () => { runtime.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(scratch, { recursive: true, force: true }); });
  await runtime.ensureRunning(`http://127.0.0.1:${port}`);
  runtime.dispose();
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/models`)).status, 401);
  assert.equal(await exists(storage), false, 'Reusing an external server must not create runtime state.');
});

test('concurrent startup launches one owned process with isolated storage, waits for HTTP401 readiness, and disposes it', async (t) => {
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'trueforage runtime owned '));
  const cli = path.join(scratch, 'extension/node_modules/@truefoundry/trueforge/dist/cli.js');
  await fs.mkdir(path.dirname(cli), { recursive: true }); await fs.writeFile(cli, servingChild);
  const storage = path.join(scratch, 'private storage');
  const logs: string[] = [];
  const runtime = new LocalRuntime({ extensionPath: path.join(scratch, 'extension'), storagePath: storage, nodePath: process.execPath, onLog: text => logs.push(text) });
  t.after(async () => { runtime.dispose(); await fs.rm(scratch, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${await freePort()}`;
  await Promise.all([runtime.ensureRunning(url), runtime.ensureRunning(url)]);
  const launched = JSON.parse(await fs.readFile(path.join(storage, 'launch.json'), 'utf8'));
  assert.equal((await fs.readFile(path.join(storage, 'launches.log'), 'utf8')).trim().split('\n').length, 1);
  assert.equal(launched.host, '127.0.0.1');
  assert.equal(launched.sqlite, path.join(storage, 'db.sqlite'));
  assert.equal(launched.cache, path.join(storage, 'npm-cache'));
  assert.equal(launched.cwd, await fs.realpath(storage));
  assert.deepEqual(launched.allowed, ['127.0.0.1', 'localhost', '::1']);
  assert.equal(logs.join('\n').includes('fixture-secret'), false);
  assert.equal(logs.join('\n').includes('fixture-auth'), false);
  assert.ok(logs.join('\n').includes('[redacted]'));
  await runtime.ensureRunning(url);
  runtime.dispose();
  await until(async () => !alive(launched.pid), 'Disposing must terminate the owned runtime process.');
});

test('cancelling startup promptly stops an owned process that never becomes ready', async (t) => {
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'trueforage-runtime-cancel-'));
  const cli = path.join(scratch, 'extension/node_modules/@truefoundry/trueforge/dist/cli.js');
  await fs.mkdir(path.dirname(cli), { recursive: true }); await fs.writeFile(cli, childPrelude + '\nsetInterval(() => {}, 1000);\n');
  const storage = path.join(scratch, 'storage');
  const runtime = new LocalRuntime({ extensionPath: path.join(scratch, 'extension'), storagePath: storage, nodePath: process.execPath });
  t.after(async () => { runtime.dispose(); await fs.rm(scratch, { recursive: true, force: true }); });
  const controller = new AbortController();
  const startup = runtime.ensureRunning(`http://127.0.0.1:${await freePort()}`, controller.signal);
  // Attach the rejection assertion before aborting to avoid an unhandled rejection.
  const rejected = assert.rejects(startup, error => error instanceof Error && error.name === 'AbortError');
  await until(() => exists(path.join(storage, 'launch.json')), 'Owned fixture process did not start.');
  const launched = JSON.parse(await fs.readFile(path.join(storage, 'launch.json'), 'utf8'));
  const cancelledAt = Date.now(); controller.abort(); await rejected;
  assert.ok(Date.now() - cancelledAt < 1_500, 'Cancellation should not wait for the 60-second startup timeout.');
  await until(async () => !alive(launched.pid), 'Cancelled startup left its owned process alive.');
});

test('a packaged extension resolves npx beside external Node and pins the downloaded runtime without a shell', { skip: process.platform === 'win32' }, async (t) => {
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'trueforage packaged runtime '));
  const node = path.join(scratch, 'external node/bin/node');
  const npx = path.join(scratch, 'external node/lib/node_modules/npm/bin/npx-cli.js');
  await fs.mkdir(path.dirname(node), { recursive: true }); await fs.mkdir(path.dirname(npx), { recursive: true });
  const quotedNode = `'${process.execPath.replace(/'/g, `'\\''`)}'`;
  await fs.writeFile(node, `#!/bin/sh\nexec ${quotedNode} "$@"\n`, { mode: 0o755 });
  await fs.writeFile(npx, servingChild);
  const storage = path.join(scratch, 'storage');
  const runtime = new LocalRuntime({ extensionPath: path.join(scratch, 'installed extension without node_modules'), storagePath: storage, nodePath: node });
  t.after(async () => { runtime.dispose(); await fs.rm(scratch, { recursive: true, force: true }); });
  const port = await freePort();
  await runtime.ensureRunning(`http://127.0.0.1:${port}`);
  const launched = JSON.parse(await fs.readFile(path.join(storage, 'launch.json'), 'utf8'));
  assert.deepEqual(launched.argv, ['--yes', '@truefoundry/trueforge@0.183.1', '--port', String(port)]);
  assert.equal(launched.path.split(path.delimiter)[0], path.dirname(await fs.realpath(node)));
  runtime.dispose();
  await until(async () => !alive(launched.pid), 'Packaged runtime process was not stopped.');
});

test('early process failure is actionable and disposing during the initial probe cannot launch afterward', async (t) => {
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'trueforage-runtime-failure-'));
  const cli = path.join(scratch, 'extension/node_modules/@truefoundry/trueforge/dist/cli.js');
  await fs.mkdir(path.dirname(cli), { recursive: true }); await fs.writeFile(cli, 'process.stderr.write("fixture startup failure\\n"); process.exit(7);');
  const runtime = new LocalRuntime({ extensionPath: path.join(scratch, 'extension'), storagePath: path.join(scratch, 'storage'), nodePath: process.execPath });
  t.after(async () => { runtime.dispose(); await fs.rm(scratch, { recursive: true, force: true }); });
  await assert.rejects(runtime.ensureRunning(`http://127.0.0.1:${await freePort()}`), /code 7[\s\S]*fixture startup failure[\s\S]*npx --yes @truefoundry\/trueforge@0\.183\.1/);
  const disposedStorage = path.join(scratch, 'must-not-be-created');
  const disposed = new LocalRuntime({ extensionPath: scratch, storagePath: disposedStorage, nodePath: process.execPath });
  const pending = disposed.ensureRunning(`http://127.0.0.1:${await freePort()}`);
  disposed.dispose();
  await assert.rejects(pending, /disposed/);
  assert.equal(await exists(disposedStorage), false);
});
