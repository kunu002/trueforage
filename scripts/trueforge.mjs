import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = path.join(root, '.trueforge');
await mkdir(state, { recursive: true });
const allowed = JSON.parse(process.env.OUTBOUND_URL_ALLOWED_HOSTS || '[]');
if (!Array.isArray(allowed)) throw new Error('OUTBOUND_URL_ALLOWED_HOSTS must be a JSON array.');
const env = { ...process.env, HOST: '127.0.0.1', SQLITE_PATH: path.join(state, 'db.sqlite'),
  OUTBOUND_URL_ALLOWED_HOSTS: JSON.stringify([...new Set([...allowed, '127.0.0.1', 'localhost', '::1'])]) };
// The allowlist permits local MCP/model endpoints. Normal public provider URLs
// retain TrueForge's standard policy; provider credentials belong in its UI.
const cli = path.join(root, 'node_modules/@truefoundry/trueforge/dist/cli.js');
const child = spawn(process.execPath, [cli, '--port', process.env.TRUEFORAGE_PORT || '8790'], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
