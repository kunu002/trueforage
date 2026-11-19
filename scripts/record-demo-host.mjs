// Keyless native walkthrough. A deterministic local fixture drives actual editor tools.
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = path.join(root, 'video/work'); const workspace = path.join(root, '.host-test/demo-video-workspace');
// Fresh profile prevents hot-exit buffers from a prior rehearsal replacing this run's fixture files.
const profile = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'tfvideo-'));
await mkdir(work, { recursive: true }); await mkdir(workspace, { recursive: true }); await mkdir(profile, { recursive: true });
for (const name of ['native-stage.json', 'native-continue.json', 'native-demo-evidence.json']) await rm(path.join(work, name), { force: true });
await writeFile(path.join(workspace, 'app.cjs'), 'module.exports = function clamp(value, min, max) {\n  return Math.min(min, Math.max(max, value));\n};\n');
await writeFile(path.join(workspace, 'app.test.cjs'), 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst clamp = require("./app.cjs");\n\ntest("below minimum", () => assert.equal(clamp(-4, 0, 10), 0));\ntest("inside bounds", () => assert.equal(clamp(5, 0, 10), 5));\ntest("above maximum", () => assert.equal(clamp(12, 0, 10), 10));\n');
await writeFile(path.join(workspace, 'README.md'), '# Clamp utility\n\nClamp a number between its minimum and maximum bounds.\n');
await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'controlled-native-demo', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
await build({ entryPoints: [path.join(root, 'test/demo-video-host.ts')], bundle: true, outfile: path.join(work, 'demo-video-host.js'), external: ['vscode'], platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning' });
const candidates = [process.env.VSCODE_EXECUTABLE, '/Applications/Visual Studio Code.app/Contents/MacOS/Code', '/Volumes/VS Code/Visual Studio Code.app/Contents/MacOS/Code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('Set VSCODE_EXECUTABLE to the desktop executable.');
const env = { ...process.env, TRUEFORAGE_TEST_ROOT: root, TRUEFORAGE_EXTERNAL_NODE: process.execPath }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [`--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(work, 'demo-video-host.js')}`,
  '--user-data-dir', profile, '--extensions-dir', path.join(root, '.host-test/demo-video-extensions'), '--remote-debugging-port=9343',
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry', '--disable-updates', '--no-sandbox', workspace], { env, stdio: 'inherit' });
console.log(`Capture CDP9343. Read ${path.join(work, 'native-stage.json')}; write {"stage":"<stage>"} to ${path.join(work, 'native-continue.json')} to advance.`);
let automatic;
if (process.argv.includes('--auto')) {
  let seen = '';
  automatic = setInterval(async () => {
    try { const state = JSON.parse(await readFile(path.join(work, 'native-stage.json'), 'utf8')); if (state.stage !== seen) {
      seen = state.stage; console.log(`AUTO ${seen}`); await new Promise(resolve => setTimeout(resolve, 1200)); await writeFile(path.join(work, 'native-continue.json'), JSON.stringify({ stage: seen }));
    } } catch {}
  }, 500);
}
const timeout = setTimeout(() => { child.kill('SIGTERM'); console.error('Controlled native recording timed out after30 minutes.'); }, 30 * 60_000);
child.on('error', error => { clearTimeout(timeout); if (automatic) clearInterval(automatic); console.error(error.message); process.exitCode = 1; });
child.on('exit', async code => {
  clearTimeout(timeout); if (automatic) clearInterval(automatic);
  let passed = false;
  try { passed = JSON.parse(await readFile(path.join(work, 'native-demo-evidence.json'), 'utf8')).status === 'passed'; } catch {}
  process.exitCode = code === 0 && passed ? 0 : 1;
});
