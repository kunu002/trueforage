import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { request } from 'node:http';
import { startMcpServer, tools, toolsForMode, type ToolHandler } from '../src/mcp';

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
}

function message(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
}

async function rpc(server: Awaited<ReturnType<typeof startMcpServer>>, method: string, params: Record<string, unknown> = {}): Promise<{ response: Response; body: any }> {
  const response = await fetch(server.url, { method: 'POST', headers: headers(server.token), body: message(method, params) });
  return { response, body: await response.json() };
}

test('MCP initialize and tools/list expose the declared coding tools over real HTTP', async (t) => {
  const server = await startMcpServer(async () => null);
  t.after(() => server.close());
  const initialized = await rpc(server, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } });
  assert.equal(initialized.response.status, 200);
  assert.equal(initialized.body.result.serverInfo.name, 'trueforage-workspace');
  const listed = await rpc(server, 'tools/list');
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body.result.tools.map((tool: { name: string }) => tool.name), tools.map((tool) => tool.name));
  const exposed = new Set(listed.body.result.tools.map((tool: { name: string }) => tool.name));
  for (const name of ['list_files', 'search_context', 'read_file', 'propose_edit', 'review_changes', 'run_command',
    'update_plan', 'get_diagnostics', 'apply_changes', 'revise_edit', 'workspace_status']) assert.ok(exposed.has(name), `${name} is available`);
});

test('MCP refuses missing and incorrect bearer tokens before dispatch', async (t) => {
  let called = false;
  const server = await startMcpServer(async () => { called = true; return null; });
  t.after(() => server.close());
  for (const token of ['', '0'.repeat(server.token.length)]) {
    const response = await fetch(server.url, { method: 'POST', headers: headers(token), body: message('tools/call', { name: 'list_files', arguments: {} }) });
    assert.equal(response.status, 401);
    await response.text();
  }
  assert.equal(called, false);
});

test('MCP denies browser origins and foreign Host headers even with a correct token', async (t) => {
  let called = false;
  const server = await startMcpServer(async () => { called = true; return null; });
  t.after(() => server.close());
  const forbiddenHeaders: Array<Record<string, string>> = [{ Origin: 'https://untrusted.example' }, { Host: 'untrusted.example' }];
  for (const extra of forbiddenHeaders) {
    // fetch normalizes Host to the URL; the raw HTTP client exercises rebinding checks.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(server.url, { method: 'POST', headers: { ...headers(server.token), ...extra } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(message('tools/call', { name: 'list_files', arguments: {} }));
    });
    assert.equal(status, 403);
  }
  assert.equal(called, false);
});

test('MCP keeps route, method and JSON errors separate from tool execution', async (t) => {
  let called = false;
  const server = await startMcpServer(async () => { called = true; return null; });
  t.after(() => server.close());
  const unknownRoute = await fetch(server.url.replace('/mcp', '/other'), { method: 'POST', headers: headers(server.token), body: message('tools/list') });
  assert.equal(unknownRoute.status, 404);
  await unknownRoute.text();
  const wrongMethod = await fetch(server.url, { headers: headers(server.token) });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  await wrongMethod.text();
  const malformed = await fetch(server.url, { method: 'POST', headers: headers(server.token), body: '{invalid' });
  assert.equal(malformed.status, 400);
  await malformed.text();
  assert.equal(called, false);
});

test('MCP passes tool arguments and returns structured tool failures without crashing HTTP', async (t) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const handler: ToolHandler = async (name, args, signal) => {
    assert.equal(signal.aborted, false);
    calls.push({ name, args });
    if (name === 'read_file') throw new Error('Path leaves workspace.');
    return { paths: ['src/main.ts'] };
  };
  const server = await startMcpServer(handler);
  t.after(() => server.close());
  const success = await rpc(server, 'tools/call', { name: 'list_files', arguments: { glob: '**/*.ts' } });
  assert.equal(success.response.status, 200);
  assert.deepEqual(JSON.parse(success.body.result.content[0].text), { paths: ['src/main.ts'] });
  const failure = await rpc(server, 'tools/call', { name: 'read_file', arguments: { path: '../outside', reason: 'test' } });
  assert.equal(failure.response.status, 200);
  assert.equal(failure.body.result.isError, true);
  assert.match(failure.body.result.content[0].text, /Path leaves workspace/);
  const unknown = await rpc(server, 'tools/call', { name: 'execute_anything', arguments: {} });
  assert.equal(unknown.body.result.isError, true);
  assert.match(unknown.body.result.content[0].text, /Unknown tool/);
  assert.deepEqual(calls, [
    { name: 'list_files', args: { glob: '**/*.ts' } },
    { name: 'read_file', args: { path: '../outside', reason: 'test' } },
  ]);
});

test('MCP client disconnect aborts a running asynchronous tool', { timeout: 5_000 }, async (t) => {
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  let finished!: () => void;
  const canFinish = new Promise<void>((resolve) => { finished = resolve; });
  let toolSignal: AbortSignal | undefined;
  const server = await startMcpServer(async (_name, _args, signal) => {
    toolSignal = signal;
    signal.addEventListener('abort', finished, { once: true });
    started();
    await canFinish;
    return { cancelled: signal.aborted };
  });
  t.after(async () => { finished(); await server.close(); });
  const controller = new AbortController();
  const response = fetch(server.url, { method: 'POST', headers: headers(server.token), body: message('tools/call', { name: 'review_changes', arguments: {} }), signal: controller.signal }).catch(() => null);
  await didStart;
  controller.abort();
  await response;
  // The close event crosses an HTTP boundary; allow one short scheduling window.
  await Promise.race([canFinish, new Promise<void>((resolve) => setTimeout(resolve, 150))]);
  assert.equal(toolSignal?.aborted, true, 'Disconnected MCP calls must release review/verification handlers.');
});

test('Ask mode hides mutation schemas and rejects direct edit/command calls before handler dispatch', async (t) => {
  const calls: string[] = [];
  const server = await startMcpServer(async name => { calls.push(name); return { observed: name }; }, { workMode: 'ask' });
  t.after(() => server.close());
  const listed = await rpc(server, 'tools/list');
  assert.deepEqual(listed.body.result.tools.map((tool: { name: string }) => tool.name), toolsForMode('ask').map(tool => tool.name));
  for (const tool of tools.filter(tool => !toolsForMode('ask').some(readonly => readonly.name === tool.name))) {
    const denied = await rpc(server, 'tools/call', { name: tool.name, arguments: {} });
    assert.equal(denied.body.result.isError, true);
    assert.match(denied.body.result.content[0].text, /Ask mode is read-only/);
  }
  const status = await rpc(server, 'tools/call', { name: 'workspace_status', arguments: {} });
  assert.equal(status.body.result.isError, undefined);
  assert.deepEqual(calls, ['workspace_status']);
});

test('Agent MCP transports plan, diagnostics, apply and revise arguments without a manual review wait', async (t) => {
  const observed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = await startMcpServer(async (name, args) => { observed.push({ name, args }); return { completed: name }; }, { workMode: 'agent' });
  t.after(() => server.close());
  const requested = [
    { name: 'update_plan', args: { steps: [{ step: 'Fix the failing test', status: 'in_progress' }] } },
    { name: 'get_diagnostics', args: { path: 'src/example.ts' } },
    { name: 'revise_edit', args: { id: 'hunk-1', newText: 'fixed', reason: 'Observed test failure' } },
    { name: 'apply_changes', args: {} },
  ];
  for (const call of requested) {
    const result = await rpc(server, 'tools/call', { name: call.name, arguments: call.args });
    assert.equal(result.body.result.isError, undefined);
    assert.deepEqual(JSON.parse(result.body.result.content[0].text), { completed: call.name });
  }
  assert.deepEqual(observed, requested);
});
