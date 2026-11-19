// Exercises the real pinned harness with a deterministic local model fixture.
// This is integration evidence, not a genuine model or editor demo.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const { TrueForgeHarness, TRUEFORGE_VERSIONS } = require(join(root, '.test-build/src/harness/client.js'));
const { startMcpServer } = require(join(root, '.test-build/src/mcp.js'));
const scratch = await mkdtemp(join(tmpdir(), 'trueforage-harness-'));
const connectorName = `trueforage-fixture-${process.pid}`;
const calls = [];
const rawEvents = [];
let providerTurns = 0;
let codingTurns = 0;
let pingRequests = 0;
let providerMode = 'ping';
let reviewApproved = false;
let staged = null;
let fixtureSource = 'value = 1\n';
let serverLog = '';
let child;
let provider;
let bridge;
let agentBridge;
const agentConnector = `${connectorName}-agent`;
const agentSourcePath = join(scratch, 'agent-fixture.cjs');
const agentTestPath = join(scratch, 'agent-fixture.test.cjs');
const agentCalls = [];
const testResults = [];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}
function output(res, content) {
  res.write(`data: ${JSON.stringify(content)}\n\n`);
}
function toolName(body, target) {
  const tools = (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean);
  const name = tools.find(name => name === target || name.endsWith(`__${target}`) || name.endsWith(`_${target}`));
  assert.ok(name, `${target} missing from model's advertised tools: ${tools.join(', ')}`);
  return name;
}
async function waitForServer(baseUrl) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`TrueForge exited ${child.exitCode}: ${serverLog.slice(-4000)}`);
    try {
      const response = await fetch(`${baseUrl}/api/v1/models`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`TrueForge startup timed out: ${serverLog.slice(-4000)}`);
}

async function runFixtureTest(executable, args) {
  assert.equal(executable, process.execPath);
  assert.deepEqual(args, ['--test', agentTestPath]);
  return new Promise((resolve, reject) => {
    const task = spawn(executable, args, { cwd: scratch, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    task.stdout.on('data', chunk => { stdout += chunk; });
    task.stderr.on('data', chunk => { stderr += chunk; });
    task.once('error', reject);
    task.once('exit', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}

try {
  bridge = await startMcpServer(async (name, args) => {
    calls.push({ name, args });
    if (name === 'list_files') return { paths: ['fixture.py'] };
    if (name === 'search_context') return { evidence: [{ path: 'fixture.py', startLine: 1, endLine: 1, text: fixtureSource, reason: 'fixture value', bytes: 10 }] };
    if (name === 'propose_edit') {
      assert.equal(args.oldText, fixtureSource);
      staged = args.newText;
      return { staged: true, id: 'fixture-hunk' };
    }
    if (name === 'review_changes') {
      assert.equal(reviewApproved, true, 'review_changes executed before user approved the harness gate');
      assert.equal(fixtureSource, 'value = 1\n', 'proposal changed fixture before review');
      assert.equal(staged, 'value = 2\n');
      fixtureSource = staged;
      return { applied: true, accepted: ['fixture-hunk'], rejected: [] };
    }
    throw new Error(`Unexpected fixture MCP call ${name}`);
  });
  provider = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(req.url, '/tenant/api/llm/chat/completions', 'Gateway Code Snippet path was changed');
      assert.equal(req.headers.authorization, 'Bearer fixture-only');
      assert.equal(body.model, 'fixture-account/deterministic-v1.2', 'upstream model ID was changed to its local alias');
      if (providerMode === 'ping') {
        pingRequests++;
        const base = { id: 'fixture-ping', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        output(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'TrueForage connected.' }, finish_reason: null }] });
        output(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
        res.end('data: [DONE]\n\n');
        return;
      }
      const coding = providerMode === 'coding';
      const stage = coding ? codingTurns++ : providerTurns++;
      if (!coding && stage === 7) {
        assert.ok(JSON.stringify(body.messages).includes('Change the fixture value to 2'), 'continued session lost its earlier user message');
        assert.ok(JSON.stringify(body.messages).includes('Summarize our previous change'), 'continued session lost its new user message');
      }
      let call;
      if (coding) {
        const invoke = (tool_name, input = {}) => ({ name: toolName(body, 'call_tool'), args: { mcp_server: agentConnector, tool_name, input } });
        if (stage === 0) call = invoke('workspace_status');
        if (stage === 1) call = invoke('update_plan', { steps: [{ step: 'Edit fixture and run its test', status: 'in_progress' }] });
        if (stage === 2) call = invoke('read_file', { path: 'agent-fixture.cjs', reason: 'Inspect the current exported value' });
        if (stage === 3) call = invoke('propose_edit', { path: 'agent-fixture.cjs', oldText: 'module.exports = { value: 1 };\n', newText: 'module.exports = { value: 2 };\n', reason: 'First fixture attempt' });
        if (stage === 4) call = invoke('apply_changes');
        if (stage === 5) call = invoke('run_command', { executable: process.execPath, args: ['--test', agentTestPath], reason: 'Run the requested fixture test' });
        if (stage === 6) {
          assert.equal(testResults[0]?.exitCode, 1, 'fixture test should expose the incorrect first edit');
          assert.ok(JSON.stringify(body.messages).includes('ERR_ASSERTION'), 'model did not receive actual failing test output');
          call = invoke('get_diagnostics', { path: 'agent-fixture.cjs' });
        }
        if (stage === 7) call = invoke('propose_edit', { path: 'agent-fixture.cjs', oldText: 'module.exports = { value: 2 };\n', newText: 'module.exports = { value: 4 };\n', reason: 'Stage a correction against the saved source' });
        if (stage === 8) call = invoke('revise_edit', { id: 'agent-hunk', newText: 'module.exports = { value: 3 };\n', reason: 'Use the expected value from the actual failed assertion' });
        if (stage === 9) call = invoke('apply_changes');
        if (stage === 10) call = invoke('run_command', { executable: process.execPath, args: ['--test', agentTestPath], reason: 'Verify the corrected implementation' });
        if (stage === 11) {
          assert.equal(testResults[1]?.exitCode, 0, 'corrected fixture test should pass');
          call = invoke('update_plan', { steps: [{ step: 'Edit fixture and run its test', status: 'completed' }] });
        }
      } else {
        if (stage === 0) call = { name: toolName(body, 'list_files'), args: {} };
        if (stage === 1) call = { name: toolName(body, 'search_context'), args: { query: 'Update the fixture value' } };
        if (stage === 2) call = { name: toolName(body, 'get_tool_info'), args: { mcp_server: connectorName, tool_name: 'propose_edit' } };
        if (stage === 3) call = { name: toolName(body, 'call_tool'), args: { mcp_server: connectorName, tool_name: 'propose_edit', input: {
          path: 'fixture.py', oldText: 'value = 1\n', newText: 'value = 2\n', reason: 'fixture change' } } };
        if (stage === 4) call = { name: toolName(body, 'get_tool_info'), args: { mcp_server: connectorName, tool_name: 'review_changes' } };
        if (stage === 5) call = { name: toolName(body, 'call_tool'), args: { mcp_server: connectorName, tool_name: 'review_changes', input: {} } };
      }
      const base = { id: `fixture-${providerMode}-${stage}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'deterministic' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (call) {
        output(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{
          index: 0, id: `fixture-call-${providerMode}-${stage}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
        }] }, finish_reason: null }] });
        output(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        output(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture change reviewed and applied.' }, finish_reason: null }] });
        output(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      console.error('Fixture provider:', error);
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  const providerPort = await listen(provider);
  const portReservation = createServer();
  const harnessPort = await listen(portReservation);
  await new Promise(resolve => portReservation.close(resolve));
  const baseUrl = `http://127.0.0.1:${harnessPort}`;
  child = spawn(process.execPath, [join(root, 'node_modules/@truefoundry/trueforge/dist/cli.js'), '--port', String(harnessPort)], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', SQLITE_PATH: join(scratch, 'db.sqlite'), STANDALONE: 'true', ACCESS_LOGS: 'false', LOG_LEVEL: 'error',
      OUTBOUND_URL_ALLOWED_HOSTS: JSON.stringify(['127.0.0.1', 'localhost', '::1']) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { serverLog += chunk; });
  child.stderr.on('data', chunk => { serverLog += chunk; });
  await waitForServer(baseUrl);
  const harness = new TrueForgeHarness({ baseUrl });
  const configured = await harness.configureTrueFoundry({ gatewayUrl: `http://127.0.0.1:${providerPort}/tenant/api/llm`,
    apiKey: 'fixture-only', modelId: 'fixture-account/deterministic-v1.2' });
  assert.equal(configured.provider, 'truefoundry');
  const sdk = new TrueForge({ baseUrl, maxRetries: 0 });
  const storedProvider = (await sdk.settings.modelProviders.list()).data.find(provider => provider.name === 'truefoundry');
  assert.equal(storedProvider.manifest.type, 'truefoundry');
  assert.ok((await harness.listModels()).some(model => model.name === configured.model));
  const ping = await harness.pingModel(configured.model);
  assert.equal(ping.text, 'TrueForage connected.');
  assert.equal(harness.sessionId, undefined, 'ping replaced the editor conversation');
  providerMode = 'agent';
  await harness.registerMcp({ name: connectorName, url: bridge.url, bearerToken: bridge.token });
  await harness.createSession({ model: configured.model, mcpServerName: connectorName,
    instructions: 'Use workspace tools to propose a change, request review and report the reviewed result.' });
  const result = await harness.streamTurn('Change the fixture value to 2 and request review.', {
    signal: AbortSignal.timeout(30_000),
    onEvent: async event => {
      if (event.type === 'raw') rawEvents.push(event.event.type);
      if (event.type === 'approval') {
        assert.equal(event.toolName, 'review_changes');
        assert.equal(calls.some(call => call.name === 'review_changes'), false);
        reviewApproved = true;
        await harness.approve(event.id, true);
      }
    },
  });
  assert.equal(result.status, 'done');
  assert.equal(fixtureSource, 'value = 2\n');
  assert.deepEqual(calls.map(call => call.name), ['list_files', 'search_context', 'propose_edit', 'review_changes']);
  assert.ok(rawEvents.includes('tool.approval_required'));
  assert.equal(rawEvents.filter(type => type === 'turn.created').length, 2);
  const nextConnector = `${connectorName}-next`;
  await harness.registerMcp({ name: nextConnector, url: bridge.url, bearerToken: bridge.token });
  await harness.updateSession({ model: configured.model, mcpServerName: nextConnector,
    instructions: 'Retain the previous conversation and answer without making another change.' });
  assert.equal(harness.sessionId, result.sessionId);
  const continued = await harness.streamTurn('Summarize our previous change without tools.', { signal: AbortSignal.timeout(30_000), onEvent: () => {} });
  assert.equal(continued.sessionId, result.sessionId);
  assert.notEqual(continued.turnId, result.turnId);
  assert.equal(continued.status, 'done');
  await writeFile(agentSourcePath, 'module.exports = { value: 1 };\n');
  await writeFile(agentTestPath, "const { value } = require('./agent-fixture.cjs');\nrequire('node:assert/strict').equal(value, 3);\n");
  let agentStaged;
  agentBridge = await startMcpServer(async (name, args) => {
    agentCalls.push(name);
    if (name === 'workspace_status') return { paths: ['agent-fixture.cjs', 'agent-fixture.test.cjs'], pending: Boolean(agentStaged) };
    if (name === 'update_plan') return { steps: args.steps };
    if (name === 'get_diagnostics') return { diagnostics: [], note: 'This fixture has no editor language service. Test results are separate.' };
    if (name === 'read_file') return { path: args.path, text: await readFile(agentSourcePath, 'utf8') };
    if (name === 'propose_edit') {
      assert.equal(args.path, 'agent-fixture.cjs');
      assert.equal(args.oldText, await readFile(agentSourcePath, 'utf8'));
      assert.equal(agentStaged, undefined);
      agentStaged = { id: 'agent-hunk', original: args.oldText, newText: args.newText };
      return { staged: true, id: agentStaged.id };
    }
    if (name === 'revise_edit') {
      assert.equal(args.id, agentStaged?.id);
      agentStaged.newText = args.newText;
      return { revised: true, id: agentStaged.id };
    }
    if (name === 'apply_changes') {
      assert.ok(agentStaged);
      assert.equal(await readFile(agentSourcePath, 'utf8'), agentStaged.original);
      await writeFile(agentSourcePath, agentStaged.newText);
      agentStaged = undefined;
      return { applied: true, files: ['agent-fixture.cjs'], saved: true };
    }
    if (name === 'run_command') {
      assert.equal(agentStaged, undefined, 'Agent must apply before running workspace verification');
      const execution = await runFixtureTest(args.executable, args.args);
      testResults.push(execution);
      return execution;
    }
    throw new Error(`Unexpected Agent fixture call ${name}`);
  }, { workMode: 'agent' });
  providerMode = 'coding';
  await harness.registerMcp({ name: agentConnector, url: agentBridge.url, bearerToken: agentBridge.token });
  await harness.createSession({ model: configured.model, mcpServerName: agentConnector, workMode: 'agent',
    instructions: 'Complete the requested edit, run its test, fix a failure and verify again.' });
  const agentResult = await harness.streamTurn('Make the fixture export the expected value and run its test. Fix any failures.', {
    signal: AbortSignal.timeout(30_000), onEvent: event => { assert.notEqual(event.type, 'approval', 'Agent must not pause for a generic review approval'); },
  });
  assert.equal(agentResult.status, 'done');
  assert.equal(await readFile(agentSourcePath, 'utf8'), 'module.exports = { value: 3 };\n');
  assert.deepEqual(testResults.map(result => result.exitCode), [1, 0]);
  assert.equal(agentCalls.filter(name => name === 'apply_changes').length, 2);
  assert.ok(agentCalls.includes('revise_edit'));
  console.log(JSON.stringify({ passed: true, kind: 'deterministic local provider; not a genuine model run', versions: TRUEFORGE_VERSIONS,
    modelRequests: providerTurns + codingTurns + pingRequests, pingRequests, providerType: storedProvider.manifest.type,
    upstreamModelId: configured.modelId, mcpCalls: calls.map(call => call.name), approvalResumes: 1, continuedSession: true,
    agentCalls, actualAgentTestExitCodes: testResults.map(result => result.exitCode), agentReviewApprovals: 0,
    pingSessionId: ping.sessionId, sessionId: result.sessionId, turnId: continued.turnId, fixtureSource }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-5000));
  throw error;
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      child.once('exit', resolve);
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref();
    });
  }
  await bridge?.close();
  await agentBridge?.close();
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
  await rm(scratch, { recursive: true, force: true });
}
