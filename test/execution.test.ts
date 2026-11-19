import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { classifyCommand, executeCommand, MAX_COMMAND_OUTPUT_BYTES } from '../src/execution';

const node = process.execPath;

test('Agent mode recognizes routine validation recipes including an absolute virtualenv Python', () => {
  const allowed: Array<[string, string[]]> = [
    ['npm', ['test', '--', '--runInBand']], ['npm', ['run', 'check']], ['npm', ['run', 'format:check']],
    ['pnpm', ['test']], ['yarn', ['test']], ['bun', ['test']], ['pnpm', ['run', 'lint']],
    ['/tmp/flask-venv/bin/python', ['-m', 'pytest', 'tests/test_cli.py', '-q']],
    ['python3', ['-B', '-m', 'unittest', 'discover']], ['python3.12', ['-m', 'compileall', '-q', 'src']],
    ['pytest', ['-q']], ['node', ['--test', 'test/agent.test.js']], ['tsc', ['--noEmit']], ['eslint', ['src']],
    ['cargo', ['test']], ['cargo', ['check']], ['cargo', ['fmt', '--check']], ['go', ['test', './...']],
    ['dotnet', ['test']], ['dotnet', ['format', '--verify-no-changes']],
    ['git', ['status', '--short']], ['git', ['--no-pager', 'diff', '--stat']], ['git', ['log', '-5']],
    ['git', ['show', 'HEAD:README.md']], ['git', ['rev-parse', 'HEAD']], ['git', ['ls-files']],
  ];
  for (const [executable, args] of allowed) assert.equal(classifyCommand({ executable, args, mode: 'agent' }).automatic, true, `${executable} ${args.join(' ')}`);
});

test('install, publish, destructive operations, injected execution and unknown scripts require exact approval', () => {
  const blocked: Array<[string, string[]]> = [
    ['npm', ['install']], ['npm', ['publish']], ['npm', ['run', 'deploy']], ['npm', ['run', 'test:publish']],
    ['npm', ['test', '--script-shell=/tmp/injected']], ['npx', ['eslint', 'src']],
    ['python3', ['-c', 'print(1)']], ['python3', ['-m', 'pip', 'install', 'anything']],
    ['node', ['-e', 'console.log(1)', '--test']], ['node', ['--test', '--import=./preload.js']],
    ['bash', ['-c', 'npm test']], ['curl', ['https://example.test']], ['rm', ['-rf', 'src']],
    ['eslint', ['--fix', 'src']], ['tsc', ['--init']], ['cargo', ['publish']], ['cargo', ['fmt']],
    ['go', ['install', 'example.test/package']], ['dotnet', ['publish']],
    ['git', ['reset', '--hard']], ['git', ['clean', '-fd']], ['git', ['push']], ['git', ['checkout', '.']],
    ['git', ['-c', 'alias.bad=!sh', 'status']], ['git', ['diff', '--ext-diff']], ['git', ['show', '--textconv', 'HEAD']],
    ['git', ['diff', '--output=README.md']], ['git', ['diff', '--no-index', '/etc/passwd', 'README.md']],
    ['npm', ['test', '&&', 'npm', 'publish']], ['npm', ['test', '$(touch marker)']],
    ['custom-validator', ['check']],
  ];
  for (const [executable, args] of blocked) assert.equal(classifyCommand({ executable, args, mode: 'agent' }).automatic, false, `${executable} ${args.join(' ')}`);
});

test('Review mode always needs exact approval and Ask mode never authorizes command execution', () => {
  for (const mode of ['review', 'ask'] as const) {
    const result = classifyCommand({ executable: 'npm', args: ['test'], mode });
    assert.equal(result.automatic, false);
    assert.match(result.reason, mode === 'review' ? /exact executable/ : /does not execute/);
  }
});

test('real command output streams before completion and preserves nonzero exit code, cwd and arguments', async (t) => {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'trueforage command streaming '));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const output: Array<{ chunk: string; stream: string }> = [];
  let completed = false;
  const args = ['-e', 'process.stdout.write("first\\n"); setTimeout(() => { process.stderr.write("warning\\n"); setTimeout(() => process.exit(3), 30); }, 30);'];
  const pending = executeCommand({ executable: node, args, cwd, onOutput: (chunk, stream) => {
    assert.equal(completed, false); output.push({ chunk, stream });
  } });
  const result = await pending; completed = true;
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, 'first\n'); assert.equal(result.stderr, 'warning\n');
  assert.deepEqual(result.args, args); assert.equal(result.executable, node); assert.equal(result.cwd, cwd);
  assert.ok(result.durationMs >= 30); assert.equal(result.truncated, false);
  assert.deepEqual(output.map(item => item.stream), ['stdout', 'stderr']);
});

test('argv metacharacters are literal and cannot invoke a shell', async (t) => {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'trueforage command literal '));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const literal = '$(touch SHELL_EXECUTED); echo expanded && other | command';
  const result = await executeCommand({ executable: node, args: ['-e', 'console.log(process.argv[1]);', literal], cwd });
  assert.equal(result.status, 'passed'); assert.equal(result.stdout.trim(), literal);
  await assert.rejects(fs.access(path.join(cwd, 'SHELL_EXECUTED')));
});

test('host environment overrides resolve an executable on the supplied PATH without changing parent environment', async (t) => {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'trueforage command environment '));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, 'host tools'); await fs.mkdir(bin);
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  // A real external executable with a spaced path demonstrates shell-free PATH lookup.
  await fs.symlink(node, path.join(bin, executable));
  const priorPath = process.env.PATH;
  const priorMarker = process.env.TRUEFORAGE_EXECUTION_TEST_MARKER;
  const result = await executeCommand({ executable, args: ['-e', 'console.log(JSON.stringify({ marker: process.env.TRUEFORAGE_EXECUTION_TEST_MARKER, path: process.env.PATH }));'], cwd,
    env: { PATH: bin, TRUEFORAGE_EXECUTION_TEST_MARKER: 'host-only-value' } });
  assert.equal(result.status, 'passed', result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { marker: 'host-only-value', path: bin });
  assert.equal(process.env.PATH, priorPath);
  assert.equal(process.env.TRUEFORAGE_EXECUTION_TEST_MARKER, priorMarker);
});

test('a missing executable produces a real structured failure rather than a passing or invented result', async () => {
  const result = await executeCommand({ executable: path.join(tmpdir(), 'trueforage-missing-executable-928124'), args: [], cwd: tmpdir() });
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, null);
  assert.match(result.stderr, /ENOENT|not found/i); assert.equal(result.stdout, '');
});

test('output capture and streaming share a strict 1 MB UTF-8 budget without splitting Unicode', async () => {
  let streamedBytes = 0;
  const result = await executeCommand({ executable: node,
    args: ['-e', 'process.stdout.write("🌱".repeat(400000), () => process.stderr.write("tail"));'], cwd: tmpdir(),
    onOutput: chunk => { streamedBytes += Buffer.byteLength(chunk, 'utf8'); } });
  const bytes = Buffer.byteLength(result.stdout + result.stderr, 'utf8');
  assert.equal(result.status, 'passed'); assert.equal(result.truncated, true);
  assert.ok(bytes <= MAX_COMMAND_OUTPUT_BYTES && bytes > 900_000);
  assert.equal(streamedBytes, bytes); assert.equal(result.stdout.includes('\uFFFD'), false);
});

test('cancelling an already-aborted command never starts a process or creates its output', async (t) => {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'trueforage command preabort '));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const controller = new AbortController(); controller.abort();
  const result = await executeCommand({ executable: node, args: ['-e', 'require("node:fs").writeFileSync("started", "yes");'], cwd, signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.exitCode, null);
  await assert.rejects(fs.access(path.join(cwd, 'started')));
});

test('timeout escalates termination for a real process that ignores SIGTERM', { timeout: 5_000 }, async () => {
  const result = await executeCommand({ executable: node, args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], cwd: tmpdir(), timeoutMs: 100 });
  assert.equal(result.status, 'timed_out'); assert.ok(result.durationMs < 3_000);
  assert.equal(result.exitCode, null);
});

test('cancellation terminates an owned process group including a SIGTERM-ignoring descendant', { timeout: 6_000, skip: process.platform === 'win32' }, async () => {
  const controller = new AbortController();
  let descendant = 0;
  const script = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{}); process.send("ready"); setInterval(()=>{},1000);'], {stdio:['ignore','ignore','ignore','ipc']});
    child.on('message',()=>process.stdout.write('DESCENDANT:'+child.pid+'\\n'));
    setInterval(()=>{},1000);`;
  const result = await executeCommand({ executable: node, args: ['-e', script], cwd: tmpdir(), signal: controller.signal,
    onOutput: chunk => {
      const match = /DESCENDANT:(\d+)/.exec(chunk);
      if (match) { descendant = Number(match[1]); controller.abort(); }
    } });
  assert.ok(descendant > 0); assert.equal(result.status, 'cancelled');
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(descendant, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  try { process.kill(descendant, 'SIGKILL'); } catch { /* Cleanup if the assertion fails. */ }
  assert.fail('Cancelled verification left its descendant running.');
});
