import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrueForgeHarness, normalizeGatewayUrl, trueFoundryModelAlias, validateTrueFoundryConfig, type HarnessEvent, type WorkMode } from '../src/harness/client';

const now = '2026-11-16T00:00:00Z';
type Wire = Record<string, unknown>;
function sse(events: Wire[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function created(turnId: string): Wire {
  return { type: 'turn.created', id: `created-${turnId}`, turn_id: turnId, thread_id: null, created_at: now,
    previous_turn_id: null, state: { status: 'running' } };
}
function done(requiredActions: Wire[] = []): Wire {
  return { type: 'turn.done', id: 'done', thread_id: null, created_at: now,
    state: { status: 'done', output: null, required_actions: requiredActions, completed_at: now } };
}
function approvalStream(): Wire[] {
  const approval = { type: 'tool.approval_required', id: 'approval-event', thread_id: 'main', created_at: now,
    tool_calls: [{ id: 'call-1', source_event_id: 'message-1' }] };
  return [
    created('turn-1'),
    { type: 'model.message', id: 'message-1', thread_id: 'main', created_at: now, content: '', tool_calls: [] },
    { type: 'model.message.delta', id: 'message-1', thread_id: 'main', content: 'Review ',
      tool_calls: [{ index: 0, id: 'call-1', type: 'function', tool_info: { type: 'truefoundry-system', name: 'call_tool' },
        function: { name: 'call_tool', arguments: '{"mcp_server":"workspace","tool_name":"review_' } }] },
    { type: 'model.message.delta', id: 'message-1', thread_id: 'main', content: 'ready.', finish_reason: 'tool_calls',
      tool_calls: [{ index: 0, function: { arguments: 'changes","input":{"summary":"three files"}}' } }] },
    approval,
    done([approval]),
  ];
}

async function fixture(turnReply: (body: Wire, number: number) => Response | Promise<Response>, route?: (path: string, body: Wire, method: string) => Response | undefined, workMode?: WorkMode) {
  const { TrueForge } = await import('@truefoundry/trueforge-sdk');
  const requests: { path: string; body: Wire; method: string }[] = [];
  let turns = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Wire : {};
    const method = init?.method ?? 'GET';
    requests.push({ path, body, method });
    const intercepted = route?.(path, body, method);
    if (intercepted) return intercepted;
    if (path === '/api/v1/sessions') return json({ data: { id: 'session-1' } });
    if (path === '/api/v1/sessions/session-1/turns') return turnReply(body, ++turns);
    if (path === '/api/v1/sessions/session-1/cancel') return json({ data: {} });
    return json({ error: { message: `unexpected ${path}` } }, 404);
  };
  const harness = new TrueForgeHarness({ baseUrl: 'http://localhost:8790' }, new TrueForge({
    baseUrl: 'http://localhost:8790', fetch: fetcher, maxRetries: 0,
  }));
  await harness.createSession({ model: 'test/model', mcpServerName: 'workspace', instructions: 'Test harness transport.', workMode });
  return { harness, requests };
}

test('official SDK decodes streamed fragments and resumes legacy approval with approval-only wire input', async () => {
  const { harness, requests } = await fixture((_body, turn) => turn === 1
    ? sse(approvalStream())
    : sse([created('turn-2'), done()]));
  const events: HarnessEvent[] = [];
  const result = await harness.streamTurn('Make the change', { onEvent: async event => {
    events.push(event);
    if (event.type === 'approval') {
      assert.equal(event.toolName, 'review_changes');
      assert.deepEqual(event.arguments, { summary: 'three files' });
      await harness.approve(event.id, true);
    }
  } });
  assert.equal(result.status, 'done');
  assert.equal(result.turnId, 'turn-2');
  assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'Review ready.');
  const turnBodies = requests.filter(request => request.path.endsWith('/turns')).map(request => request.body);
  assert.equal(turnBodies.length, 2);
  assert.deepEqual(turnBodies[1].input, [{
    type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call-1', approval: { status: 'allow' },
  }]);
  assert.equal(requests.some(request => request.path.endsWith('/events')), false);
});

test('cancellation during a pending legacy approval stops without sending approval or another turn', async () => {
  const { harness, requests } = await fixture(() => sse(approvalStream()));
  const controller = new AbortController();
  const result = await harness.streamTurn('Make the change', { signal: controller.signal, onEvent: event => {
    if (event.type === 'status' && event.text.startsWith('Waiting for your review')) controller.abort();
  } });
  assert.equal(result.status, 'cancelled');
  assert.equal(requests.filter(request => request.path.endsWith('/turns')).length, 1);
  // Server cancellation is initiated separately from the immediate local abort.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(request => request.path.endsWith('/cancel')).length, 1);
});

test('an interrupted SSE response fails clearly and never replays the turn POST', async () => {
  const { harness, requests } = await fixture(() => sse([created('turn-1')]));
  await assert.rejects(harness.streamTurn('Make the change', { onEvent: () => {} }), /before turn\.done/);
  assert.equal(requests.filter(request => request.path.endsWith('/turns')).length, 1);
});

test('an approval without its source tool call fails closed', async () => {
  const { harness } = await fixture(() => sse([
    created('turn-1'),
    { type: 'tool.approval_required', id: 'approval-event', thread_id: 'main', created_at: now,
      tool_calls: [{ id: 'unknown', source_event_id: 'missing' }] },
  ]));
  await assert.rejects(harness.streamTurn('Make the change', { onEvent: () => {} }), /No action was approved/);
});

test('Gateway URL validation preserves documented SaaS and reverse proxy paths without inventing API suffixes', () => {
  assert.equal(normalizeGatewayUrl(' https://gateway.truefoundry.ai/ '), 'https://gateway.truefoundry.ai');
  assert.equal(normalizeGatewayUrl('https://tenant.example/api/llm/'), 'https://tenant.example/api/llm');
  assert.equal(normalizeGatewayUrl('https://tenant.example/custom/api/llm/v1'), 'https://tenant.example/custom/api/llm/v1');
  for (const invalid of ['http://remote.example/api/llm', 'https://user:key@host.example', 'https://host.example?api_key=secret',
    'https://host.example/#secret', 'https://host.example/chat/completions', 'file:///tmp/key']) {
    assert.throws(() => normalizeGatewayUrl(invalid));
  }
  assert.equal(normalizeGatewayUrl('http://127.0.0.1:8888/fixture'), 'http://127.0.0.1:8888/fixture');
});

test('upstream model IDs retain their account prefix while local names meet pinned TrueForge restrictions', () => {
  const validated = validateTrueFoundryConfig({ gatewayUrl: 'https://gateway.truefoundry.ai', apiKey: ' fixture-key ', modelId: 'openai-main/gpt-4o' });
  assert.equal(validated.modelId, 'openai-main/gpt-4o');
  assert.equal(validated.providerName, 'truefoundry');
  assert.notEqual(trueFoundryModelAlias('account/model'), trueFoundryModelAlias('account-model'));
  assert.match(trueFoundryModelAlias('7-model/' + 'v'.repeat(100)), /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/);
  for (const config of [{ ...validated, apiKey: '' }, { ...validated, modelId: 'not a model' }, { ...validated, providerName: 'Bad_Name' }]) {
    assert.throws(() => validateTrueFoundryConfig(config));
  }
});

test('TrueFoundry configuration uses the official native manifest, preserves previous models and excludes secrets from its result', async () => {
  const { harness, requests } = await fixture(() => sse([done()]), (path, body, method) => {
    if (path !== '/api/v1/settings/model-providers') return;
    if (method === 'GET') return json({ data: [{ name: 'truefoundry', manifest: {
      type: 'truefoundry', base_url: 'https://gateway.truefoundry.ai', auth: { api_key: '***' },
      models: [{ name: 'previous-model', model_id: 'old-account/model', properties: { context_length: 16000 } }],
    } }] });
    return json({ data: { name: 'truefoundry', manifest: body.manifest } });
  });
  const configured = await harness.configureTrueFoundry({ gatewayUrl: 'https://gateway.truefoundry.ai', apiKey: 'fixture-only-key', modelId: 'openai-main/gpt-4o' });
  assert.equal(configured.provider, 'truefoundry');
  assert.equal(configured.modelId, 'openai-main/gpt-4o');
  assert.match(configured.model, /^truefoundry\/openai-main-gpt-4o-/);
  assert.equal(JSON.stringify(configured).includes('fixture-only-key'), false);
  const manifest = requests.find(request => request.method === 'PUT')?.body.manifest as Wire;
  assert.equal(manifest.type, 'truefoundry');
  assert.equal(manifest.base_url, 'https://gateway.truefoundry.ai');
  assert.deepEqual(manifest.auth, { api_key: 'fixture-only-key' });
  const models = manifest.models as Wire[];
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], { name: 'previous-model', model_id: 'old-account/model', properties: { context_length: 16000 } });
  assert.equal(models[1].model_id, 'openai-main/gpt-4o');
});

test('TrueFoundry configuration preserves a conflicting existing gateway and does not send its key', async () => {
  const { harness, requests } = await fixture(() => sse([done()]), path => path === '/api/v1/settings/model-providers'
    ? json({ data: [{ name: 'truefoundry', manifest: { type: 'truefoundry', base_url: 'https://other.example/api/llm', models: [] } }] })
    : undefined);
  await assert.rejects(harness.configureTrueFoundry({ gatewayUrl: 'https://gateway.truefoundry.ai', apiKey: 'fixture-key', modelId: 'account/model' }), /already uses another gateway/);
  assert.equal(requests.some(request => request.method === 'PUT'), false);
});

test('model ping uses a separate tool-free TrueForge session and leaves the active editor session intact', async () => {
  let sessions = 0;
  const { harness, requests } = await fixture(() => sse([done()]), (path) => {
    if (path === '/api/v1/sessions') return json({ data: { id: ++sessions === 1 ? 'session-1' : 'ping-session' } });
    if (path === '/api/v1/sessions/ping-session/turns') return sse([
      created('ping-turn'),
      { type: 'model.message.delta', id: 'ping-message', thread_id: 'main', content: 'TrueForage connected.' }, done(),
    ]);
  });
  const result = await harness.pingModel('truefoundry/test-model');
  assert.equal(result.sessionId, 'ping-session');
  assert.equal(result.turnId, 'ping-turn');
  assert.equal(result.text, 'TrueForage connected.');
  assert.equal(harness.sessionId, 'session-1');
  assert.equal(harness.turnId, undefined);
  const pingSpec = ((requests.filter(request => request.path === '/api/v1/sessions')[1].body.agent as Wire).spec as Wire);
  assert.deepEqual(pingSpec.mcp_servers, []);
  assert.deepEqual(pingSpec.model, { name: 'truefoundry/test-model' });
});

test('model connection errors provide an actionable category without exposing upstream credentials', async () => {
  const { harness } = await fixture(() => sse([created('ping-turn'), {
    type: 'turn.done', id: 'failed', thread_id: null, created_at: now,
    state: { status: 'error', completed_at: now, message: '401: invalid key fixture-sensitive-value' },
  }]));
  await assert.rejects(harness.pingModel('truefoundry/test-model'), error => {
    assert.match(String(error), /API key and permission/);
    assert.equal(String(error).includes('fixture-sensitive-value'), false);
    return true;
  });
});

test('updating an inline session rotates its MCP spec without creating a replacement conversation', async () => {
  const { harness, requests } = await fixture(() => sse([done()]), (path, _body, method) => path === '/api/v1/sessions/session-1' && method === 'PATCH'
    ? json({ data: { id: 'session-1' } }) : undefined);
  await harness.updateSession({ model: 'test/model', mcpServerName: 'workspace-next', instructions: 'Keep the conversation.' });
  assert.equal(harness.sessionId, 'session-1');
  assert.equal(requests.filter(request => request.path === '/api/v1/sessions').length, 1);
  const spec = ((requests.find(request => request.method === 'PATCH')?.body.agent as Wire).spec as Wire);
  assert.equal((spec.mcp_servers as Wire[])[0].name, 'workspace-next');
  assert.deepEqual((spec.mcp_servers as Wire[])[0].require_approval_for_tools, ['review_changes', 'run_command']);
});

test('Gemini HTTP 400 invalid-key responses identify provider authentication without requiring cloud Gateway signup', async () => {
  const { harness } = await fixture(() => sse([created('ping-turn'), {
    type: 'turn.done', id: 'invalid-google-key', thread_id: null, created_at: now,
    state: { status: 'error', completed_at: now, message: '[Model Error] Request failed (400): API key not valid. Please pass a valid API key. fixture-sensitive-value' },
  }]));
  await assert.rejects(harness.pingModel('google-gemini/fixture-model'), error => {
    assert.match(String(error), /model provider rejected.*API key and permission/);
    assert.equal(String(error).includes('Gateway'), false);
    assert.equal(String(error).includes('fixture-sensitive-value'), false);
    return true;
  });
});

test('Agent authorizes the working loop while Review retains exact harness gates and Ask excludes mutating tools', async () => {
  for (const mode of ['agent', 'review', 'ask'] as const) {
    const { requests } = await fixture(() => sse([done()]), undefined, mode);
    const spec = ((requests[0].body.agent as Wire).spec as Wire);
    const connector = (spec.mcp_servers as Wire[])[0];
    assert.match(String(spec.instructions), new RegExp(`WORK MODE: ${mode.toUpperCase()}`));
    assert.deepEqual(connector.require_approval_for_tools, mode === 'review' ? ['review_changes', 'run_command'] : []);
    assert.equal(connector.preload, false, 'Secondary tools remain deferred.');
    assert.deepEqual(connector.preload_tools, mode === 'agent'
      ? ['list_files', 'search_context', 'read_file', 'propose_edit', 'apply_changes', 'revise_edit', 'run_command']
      : ['list_files', 'search_context']);
    if (mode === 'ask') {
      assert.deepEqual(connector.enable_tools, ['list_files', 'search_context', 'read_file', 'get_diagnostics', 'workspace_status']);
    } else assert.deepEqual(connector.enable_tools, ['@all']);
    if (mode === 'agent') {
      assert.match(String(spec.instructions), /apply_changes/);
      assert.match(String(spec.instructions), /run_command/);
    }
  }
});

test('Google project access denial is distinct from invalid credentials and never echoes the provider body', async () => {
  const { harness } = await fixture(() => sse([created('denied-turn'), {
    type: 'turn.done', id: 'google-project-denied', thread_id: null, created_at: now,
    state: { status: 'error', completed_at: now, message: '[Model Error] Request failed (403): Your project has been denied access. Please contact support. fixture-sensitive-value' },
  }]));
  await assert.rejects(harness.pingModel('google-gemini/fixture-model'), error => {
    assert.match(String(error), /denied access to this project/);
    assert.match(String(error), /Google AI Studio and Google Cloud/);
    assert.doesNotMatch(String(error), /fixture-sensitive-value|invalid.*key/);
    return true;
  });
});

test('Google disabled API response identifies project setup rather than asking for another key', async () => {
  const { harness } = await fixture(() => sse([created('disabled-turn'), {
    type: 'turn.done', id: 'google-service-disabled', thread_id: null, created_at: now,
    state: { status: 'error', completed_at: now, message: '403 PERMISSION_DENIED: SERVICE_DISABLED: Generative Language API has not been used in this project or is disabled.' },
  }]));
  await assert.rejects(harness.pingModel('google-gemini/fixture-model'), /Enable the Generative Language API/);
});

test('availability audit distinguishes an empty configured catalog from an unreachable API without model calls', async () => {
  const empty = await fixture(() => sse([done()]), path => path === '/api/v1/models' ? json({ data: [] }) : undefined);
  const noModels = await empty.harness.getAvailability();
  assert.equal(noModels.status, 'no_models');
  assert.match(noModels.message, /Settings → Models/);
  assert.equal(empty.requests.some(request => request.path.endsWith('/turns')), false);
  const failed = await fixture(() => sse([done()]), path => path === '/api/v1/models' ? json({ error: { message: 'unavailable' } }, 503) : undefined);
  const unreachable = await failed.harness.getAvailability();
  assert.equal(unreachable.status, 'unreachable');
  assert.match(unreachable.message, /npm run trueforge/);
  assert.equal(failed.requests.some(request => request.path.endsWith('/turns')), false);
});
