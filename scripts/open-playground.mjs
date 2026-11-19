import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = [process.env.VSCODE_EXECUTABLE, '/Applications/Visual Studio Code.app/Contents/MacOS/Code', '/Volumes/VS Code/Visual Studio Code.app/Contents/MacOS/Code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('Set VSCODE_EXECUTABLE to your VS Code desktop executable.');
const playground = process.argv.includes('--playground');
const requestedWorkspace = process.argv.slice(2).find(argument => !argument.startsWith('--'));
const workspace = requestedWorkspace ? path.resolve(requestedWorkspace) : playground ? path.join(root, 'fixtures/workspace') : root;
const profile = path.join(root, '.host-test', playground ? 'playground-profile' : 'assistant-profile'); await mkdir(profile, { recursive: true });
const env = { ...process.env, TRUEFORAGE_SHOW_PLAYGROUND: playground ? '1' : '0' }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [`--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'dist/showcase.js')}`,
  '--user-data-dir', profile, '--extensions-dir', path.join(root, '.host-test/extensions'), '--skip-welcome', '--skip-release-notes',
  '--disable-workspace-trust', '--disable-telemetry', '--disable-updates', '--remote-debugging-port=9341', workspace],
  { env, detached: true, stdio: 'ignore' });
child.unref(); console.log(`Opened TrueForage ${playground ? 'playground' : 'chat'} in a dedicated VS Code Extension Development Host.`);
