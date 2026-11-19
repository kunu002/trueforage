import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createServer, type Server, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { Studio } from '../src/extension';
import { LocalRuntime } from '../src/runtime';
import { TrueForgeHarness } from '../src/harness/client';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function waitUntil(check: () => boolean, detail: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Native live fixture timed out: ${detail()}`);
}

function emit(res: ServerResponse, value: unknown): void { res.write(`data: ${JSON.stringify(value)}\n\n`); }

function toolName(body: any, wanted: string): string {
  const names = (body.tools ?? []).map((tool: any) => tool.function?.name).filter(Boolean) as string[];
  const found = names.find(name => name === wanted || name.endsWith(`__${wanted}`) || name.endsWith(`_${wanted}`));
  assert.ok(found, `Fixture could not find ${wanted} among advertised tools: ${names.join(', ')}`);
  return found;
}

/** Actual extension → pinned harness → deterministic gateway → authenticated editor MCP.
 * The gateway is a fixture. This is never recorded as a genuine model run.
 */
export async function runLiveEditorChecks(studio: Studio, extensionPath: string, results: string[]): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, 'Native live fixture needs its isolated test workspace.');
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'trueforage-native-live-'));
  const runtimeLogs: string[] = [];
  const runtime = new LocalRuntime({ extensionPath, storagePath: path.join(scratch, 'runtime'), onLog: text => runtimeLogs.push(text) });
  const providerErrors: Error[] = [];
  let mode: 'inline' | 'chat' | 'fresh' = 'inline';
  let inlineCalls = 0;
  let chatCalls = 0;
  let verifiedOutsideRejection = false;
  const config = vscode.workspace.getConfiguration('trueforage');
  const previousUrl = config.inspect<string>('harnessUrl')?.workspaceValue;
  const previousModel = config.inspect<string>('model')?.workspaceValue;
  const previousFallback = config.inspect<string[]>('fallbackModels')?.workspaceValue;
  const provider = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(req.url, '/fixture/api/llm/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer fixture-only');
      assert.equal(body.model, 'fixture-account/editor-native');
      const bridge = (studio as unknown as { bridge?: { url: string } }).bridge;
      assert.ok(bridge, 'Studio must register an authenticated workspace bridge.');
      const connector = `trueforage-${process.pid}-${new URL(bridge.url).port}`;
      const base = { id: `native-${mode}-${inlineCalls}-${chatCalls}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
      let call: { name: string; args: Record<string, unknown> } | undefined;
      let content: string | undefined;
      if (mode === 'inline') {
        const stage = inlineCalls++;
        if (stage === 0) call = { name: toolName(body, 'get_tool_info'), args: { mcp_server: connector, tool_name: 'propose_edit' } };
        if (stage === 1) call = { name: toolName(body, 'call_tool'), args: { mcp_server: connector, tool_name: 'propose_edit', input: {
          path: 'src/debug.py', oldText: 'import os', newText: 'import os  # outside the selected function', reason: 'Probe the enforced selection boundary.' } } };
        if (stage === 2) {
          assert.match(JSON.stringify(body.messages), /escapes the selected code/);
          verifiedOutsideRejection = true;
          call = { name: toolName(body, 'call_tool'), args: { mcp_server: connector, tool_name: 'propose_edit', input: {
            path: 'src/debug.py', oldText: '("", "0", "false", "no")', newText: '("", "0", "false", "no", "off", "n")', reason: 'Add both false values within the selected function.' } } };
        }
        if (stage === 3) call = { name: toolName(body, 'get_tool_info'), args: { mcp_server: connector, tool_name: 'review_changes' } };
        if (stage === 4) call = { name: toolName(body, 'call_tool'), args: { mcp_server: connector, tool_name: 'review_changes', input: {} } };
        if (stage >= 5) content = 'The selected debug function was reviewed and updated.';
      } else if (mode === 'chat') {
        const context = JSON.stringify(body.messages);
        if (chatCalls++ === 0) content = 'Ready: orchard-62.';
        else {
          assert.ok(context.includes('Remember the marker orchard-62 and say ready.'));
          assert.ok(context.includes('What marker did I ask you to remember?'));
          content = 'Your marker is orchard-62.';
        }
      } else {
        assert.equal(JSON.stringify(body.messages).includes('orchard-62'), false, 'New chat retained the previous server conversation.');
        content = 'This is a fresh chat.';
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (call) {
        emit(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0,
          id: `native-inline-call-${inlineCalls}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] });
        emit(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        emit(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
        emit(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      providerErrors.push(error instanceof Error ? error : new Error(String(error)));
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(error) } }));
      else res.end();
    }
  });
  try {
    const providerPort = await listen(provider);
    const reservation = createServer(); const runtimePort = await listen(reservation);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const baseUrl = `http://127.0.0.1:${runtimePort}`;
    await runtime.ensureRunning(baseUrl, AbortSignal.timeout(30_000));
    const setup = new TrueForgeHarness({ baseUrl });
    const configured = await setup.configureTrueFoundry({ gatewayUrl: `http://127.0.0.1:${providerPort}/fixture/api/llm`, apiKey: 'fixture-only', modelId: 'fixture-account/editor-native' });
    await config.update('harnessUrl', baseUrl, vscode.ConfigurationTarget.Workspace);
    await config.update('model', configured.model, vscode.ConfigurationTarget.Workspace);
    await config.update('fallbackModels', [], vscode.ConfigurationTarget.Workspace);
    studio.newSession();
    studio.setWorkMode('review');
    const debug = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'src/debug.py'));
    const original = debug.getText();
    const scope = { path: 'src/debug.py', start: original.indexOf('def get_debug_flag'), end: original.length, content: original };
    assert.ok(scope.start >= 0);
    const run = studio.run('Add off and n to the selected function false values.', scope, root);
    await waitUntil(() => studio.state.status === 'review' && studio.changes.list().length === 1,
      () => `${studio.state.status}: ${studio.state.error}\n${studio.state.logs.slice(-5).join('\n')}\n${providerErrors.map(error => error.message).join('\n')}`);
    assert.equal(verifiedOutsideRejection, true);
    assert.equal(debug.getText(), original, 'Live proposals must remain staged until human review.');
    const hunk = studio.changes.list()[0];
    await studio.showDiff(hunk.id); studio.review(hunk.id, 'accepted'); await studio.apply(); await run;
    assert.equal(studio.state.status, 'complete', studio.state.error);
    assert.equal(debug.getText(), original.replace('("", "0", "false", "no")', '("", "0", "false", "no", "off", "n")'));
    results.push('Actual extension → TrueForge → deterministic gateway → MCP rejects an out-of-selection edit, streams a valid inline proposal and applies it after native review.');

    studio.newSession(); mode = 'chat';
    await studio.run('Remember the marker orchard-62 and say ready.', undefined, root);
    assert.equal(studio.state.status, 'complete', studio.state.error);
    const firstSession = studio.state.sessionId;
    const firstBridge = (studio as unknown as { bridge: { url: string } }).bridge.url;
    await studio.run('What marker did I ask you to remember?', undefined, root);
    assert.equal(studio.state.status, 'complete', studio.state.error);
    assert.equal(studio.state.sessionId, firstSession);
    assert.notEqual((studio as unknown as { bridge: { url: string } }).bridge.url, firstBridge);
    assert.deepEqual(studio.state.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(studio.state.messages[1].content, 'Ready: orchard-62.');
    assert.equal(studio.state.messages[3].content, 'Your marker is orchard-62.');
    results.push('Two actual Studio.run turns preserve the TrueForge conversation and four chat rows while rotating the authenticated MCP bridge.');

    studio.newSession(); assert.equal(studio.state.messages.length, 0); mode = 'fresh';
    await studio.run('Start a completely fresh conversation.', undefined, root);
    assert.equal(studio.state.status, 'complete', studio.state.error);
    assert.notEqual(studio.state.sessionId, firstSession);
    assert.equal(studio.state.messages.length, 2);
    assert.equal(JSON.stringify(studio.state).includes('fixture-only'), false, 'Gateway credential reached the webview state.');
    await studio.undo(); assert.equal(debug.getText(), original);
    assert.equal(providerErrors.length, 0, providerErrors.map(error => error.message).join('\n'));
    results.push('New chat starts a fresh harness session; previous applied editor work can still be undone after follow-up messages. Gateway credential stays out of panel state.');
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRuntime logs: ${runtimeLogs.slice(-8).join('\n')}`);
  } finally {
    studio.cancel();
    await config.update('harnessUrl', previousUrl, vscode.ConfigurationTarget.Workspace);
    await config.update('model', previousModel, vscode.ConfigurationTarget.Workspace);
    await config.update('fallbackModels', previousFallback, vscode.ConfigurationTarget.Workspace);
    runtime.dispose();
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await new Promise(resolve => setTimeout(resolve, 250));
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
