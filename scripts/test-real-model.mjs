// Uses the team's already-configured local model. It never reads or modifies provider credentials.
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = [process.env.VSCODE_EXECUTABLE, '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  '/Volumes/VS Code/Visual Studio Code.app/Contents/MacOS/Code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('Set VSCODE_EXECUTABLE to the VS Code desktop executable.');
const baseUrl = process.env.TRUEFORAGE_REAL_HARNESS_URL || 'http://127.0.0.1:8790';
const model = process.env.TRUEFORAGE_REAL_MODEL || 'google-gemini/gemini-3-1-flash-lite';
const profile = path.join(root, '.host-test/real-model-profile');
const workspace = path.join(root, '.host-test/real-model-workspace');
await mkdir(path.join(workspace, '.vscode'), { recursive: true }); await mkdir(profile, { recursive: true });
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const artifactPath = path.join(root, 'artifacts/real-model-smoke.json');
await writeFile(artifactPath, JSON.stringify({ status: 'running', date: new Date().toISOString(), model, verified: false, realModelUsed: false }, null, 2) + '\n');
await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'trueforage-real-model-smoke', private: true,
  scripts: { test: 'node --test' } }, null, 2) + '\n');
await writeFile(path.join(workspace, 'app.cjs'), 'module.exports = function clamp(value, min, max) {\n  return Math.min(min, Math.max(max, value));\n};\n');
await writeFile(path.join(workspace, 'app.test.cjs'), 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst clamp = require("./app.cjs");\n\ntest("below minimum", () => assert.equal(clamp(-4, 0, 10), 0));\ntest("inside bounds", () => assert.equal(clamp(5, 0, 10), 5));\ntest("above maximum", () => assert.equal(clamp(12, 0, 10), 10));\n');
await writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({ 'trueforage.harnessUrl': baseUrl,
  'trueforage.model': model, 'trueforage.workMode': 'agent', 'trueforage.fallbackModels': [] }, null, 2) + '\n');
const env = { ...process.env, TRUEFORAGE_TEST_ROOT: root, TRUEFORAGE_REAL_HARNESS_URL: baseUrl,
  TRUEFORAGE_REAL_MODEL: model, TRUEFORAGE_EXTERNAL_NODE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const args = [`--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'dist/real-host.js')}`,
  '--user-data-dir', profile, '--extensions-dir', path.join(root, '.host-test/real-model-extensions'), '--remote-debugging-port=9342',
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry', '--disable-updates', '--no-sandbox', workspace];
const child = spawn(executable, args, { env, stdio: 'inherit' });
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true; child.kill('SIGTERM');
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2_000).unref();
  console.error('Real-model editor smoke check timed out after 150 seconds.');
}, 150_000);
child.on('error', error => { clearTimeout(timeout); console.error(error.message); process.exitCode = 1; });
child.on('exit', async code => {
  clearTimeout(timeout);
  let passed = false;
  try {
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
    passed = artifact.status === 'passed';
    if (artifact.status === 'running') await writeFile(artifactPath, JSON.stringify({ ...artifact, status: 'failed',
      error: timedOut ? 'Native real-model smoke check exceeded the 150-second process deadline.' : `Native test host exited with code ${code} before recording a result.` }, null, 2) + '\n');
  } catch {}
  process.exitCode = !timedOut && code === 0 && passed ? 0 : 1;
});
