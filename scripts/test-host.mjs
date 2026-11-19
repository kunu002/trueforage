import { spawn } from 'node:child_process';
import { access, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = [process.env.VSCODE_EXECUTABLE, '/Applications/Visual Studio Code.app/Contents/MacOS/Code', '/Volumes/VS Code/Visual Studio Code.app/Contents/MacOS/Code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('Set VSCODE_EXECUTABLE to your VS Code desktop executable.');
const state = path.join(root, '.host-test');
await mkdir(state, { recursive: true });
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await cp(path.join(root, 'fixtures/workspace'), path.join(state, 'workspace'), { recursive: true, force: true });
const env = { ...process.env, TRUEFORAGE_TEST_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
const args = [`--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'dist/host.js')}`,
  '--user-data-dir', path.join(state, 'profile'), '--extensions-dir', path.join(state, 'extensions'),
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry', '--disable-updates',
  '--no-sandbox', path.join(state, 'workspace')];
const child = spawn(executable, args, { env, stdio: 'inherit' });
const timeout = setTimeout(() => { child.kill('SIGTERM'); console.error('Editor host test timed out after 90 seconds.'); }, 90000);
child.on('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
