import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createServer, type Server, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { Studio } from '../src/extension';
import { LocalRuntime } from '../src/runtime';
import { TrueForgeHarness } from '../src/harness/client';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}

function emit(res: ServerResponse, value: unknown): void { res.write(`data: ${JSON.stringify(value)}\n\n`); }

function toolName(body: any, wanted: string): string {
  const names = (body.tools ?? []).map((tool: any) => tool.function?.name).filter(Boolean) as string[];
  const name = names.find(item => item === wanted || item.endsWith(`__${wanted}`) || item.endsWith(`_${wanted}`));
  assert.ok(name, `Agent fixture could not find ${wanted}: ${names.join(', ')}`); return name;
}

async function externalNode(): Promise<string> {
  const configured = vscode.workspace.getConfiguration('trueforage').get<string>('nodePath', '');
  const candidates = [configured, path.join(homedir(), '.local/bin/node'), ...(process.env.NVM_BIN ? [path.join(process.env.NVM_BIN, 'node')] : []),
    ...String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'))];
  for (const candidate of candidates.filter(Boolean)) { try { await fs.access(candidate); return await fs.realpath(candidate); } catch { /* Try the next external Node. */ } }
  throw new Error('Agent native fixture needs an external Node executable for real node --test verification.');
}

interface Operation { name: string; input: Record<string, unknown>; before?: () => Promise<void> | void }

/** Real native Agent editing/testing with a deterministic local provider, never model-solving evidence. */
export async function runAgentEditorChecks(studio: Studio, extensionPath: string, results: string[]): Promise<void> {
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'trueforage-agent-native-'));
  const project = path.join(scratch, 'workspace'); await fs.mkdir(project);
  const sourcePath = path.join(project, 'agent-value.cjs');
  const original = 'module.exports = () => 1;\n';
  const incorrect = 'module.exports = () => 3;\n';
  const corrected = 'module.exports = () => 2;\n';
  const saveComment = '// saved by the native fixture save participant\n';
  const sourceUri = vscode.Uri.file(sourcePath);
  let saveParticipantRan = false;
  const saveParticipant = vscode.workspace.onWillSaveTextDocument(event => {
    if (!saveParticipantRan && event.document.uri.toString() === sourceUri.toString() && event.document.getText() === incorrect) {
      saveParticipantRan = true;
      event.waitUntil(Promise.resolve([vscode.TextEdit.insert(new vscode.Position(0, 0), saveComment)]));
    }
  });
  await fs.writeFile(sourcePath, original);
  await fs.writeFile(path.join(project, 'agent-value.test.cjs'), 'const test = require("node:test"); const assert = require("node:assert/strict"); const value = require("./agent-value.cjs");\ntest("the value is two", () => assert.equal(value(), 2));\n');
  const node = await externalNode();
  const command = { executable: node, args: ['--test', 'agent-value.test.cjs'], reason: 'Run the actual fixture assertion in this task workspace.' };
  const runtimeLogs: string[] = [];
  const runtime = new LocalRuntime({ extensionPath, storagePath: path.join(scratch, 'runtime'), nodePath: node, onLog: text => runtimeLogs.push(text) });
  const config = vscode.workspace.getConfiguration('trueforage');
  const priorUrl = config.inspect<string>('harnessUrl')?.workspaceValue;
  const priorModel = config.inspect<string>('model')?.workspaceValue;
  const priorFallbacks = config.inspect<string[]>('fallbackModels')?.workspaceValue;
  const priorMode = studio.state.workMode;
  let mode: 'agent' | 'late' | 'ask' = 'agent';
  let index = 0; let advertised = false;
  let asksDenied = 0;
  const loaded = new Set<string>();
  const providerErrors: Error[] = [];
  const operations: Operation[] = [
    { name: 'update_plan', input: { steps: [{ step: 'Change the fixture value.', status: 'in_progress' }, { step: 'Run its test and inspect failures.', status: 'pending' }, { step: 'Correct the failure and verify.', status: 'pending' }] } },
    { name: 'propose_edit', input: { path: 'agent-value.cjs', oldText: original, newText: incorrect, reason: 'First edit in the iterative fixture.' } },
    { name: 'apply_changes', input: {} },
    { name: 'run_command', input: command, before: async () => assert.equal(await fs.readFile(sourcePath, 'utf8'), saveComment + incorrect, 'Agent apply_changes did not persist its first batch and native save participant.') },
    { name: 'update_plan', input: { steps: [{ step: 'Change the fixture value.', status: 'completed' }, { step: 'Run its test and inspect failures.', status: 'completed' }, { step: 'Correct the failure and verify.', status: 'in_progress' }] }, before: () => {
      assert.equal(studio.state.commands.length, 1); assert.equal(studio.state.commands[0].status, 'failed');
      assert.equal(studio.state.commands[0].exitCode, 1); assert.match(studio.state.commands[0].stdout, /not ok|fail/i);
      assert.match(studio.state.commands[0].stdout + studio.state.commands[0].stderr, /3\s*!==\s*2|actual[^\n]*3/i);
    } },
    { name: 'propose_edit', input: { path: 'agent-value.cjs', oldText: incorrect, newText: corrected, reason: 'The real assertion expected 2; correct the observed failure against the saved current file.' } },
    { name: 'run_command', input: command },
    { name: 'update_plan', input: { steps: [{ step: 'Change the fixture value.', status: 'completed' }, { step: 'Run its test and inspect failures.', status: 'completed' }, { step: 'Correct the failure and verify.', status: 'completed' }] }, before: async () => {
      assert.equal(await fs.readFile(sourcePath, 'utf8'), saveComment + corrected, 'Agent verification did not apply/save its pending correction.');
      assert.equal(studio.state.commands.length, 2); assert.equal(studio.state.commands[1].status, 'passed'); assert.equal(studio.state.commands[1].exitCode, 0);
      assert.match(studio.state.commands[1].stdout, /pass 1|ok 1/i);
    } },
  ];
  const lateOperations: Operation[] = [
    { name: 'propose_edit', input: { path: 'agent-value.cjs', oldText: original, newText: corrected, reason: 'Make the tested correction for the verification-revision fixture.' } },
    { name: 'apply_changes', input: {} },
    { name: 'run_command', input: command },
    { name: 'propose_edit', input: { path: 'agent-value.cjs', oldText: corrected, newText: 'module.exports = () => 4;\n', reason: 'Make a later edit after the passing test; this final state has not been rerun.' }, before: () => {
      assert.equal(studio.state.commands.length, 1); assert.equal(studio.state.commands[0].status, 'passed'); assert.equal(studio.state.commands[0].exitCode, 0);
    } },
    { name: 'apply_changes', input: {} },
  ];
  const provider = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(req.url, '/agent-fixture/api/llm/chat/completions'); assert.equal(req.headers.authorization, 'Bearer fixture-only');
      const bridge = (studio as unknown as { bridge?: { url: string; token: string } }).bridge;
      assert.ok(bridge, 'Native Agent task must expose its authenticated MCP bridge.');
      const connector = `trueforage-${process.pid}-${new URL(bridge.url).port}`;
      let call: { name: string; args: Record<string, unknown> } | undefined;
      let content = '';
      if (mode === 'ask') {
        // Exercise the real authenticated editor boundary directly, even though
        // the harness also omits mutating tools from the Ask model's tool list.
        for (const operation of [
          { name: 'propose_edit', arguments: { path: 'agent-value.cjs', oldText: original, newText: corrected, reason: 'Forbidden Ask edit.' } },
          { name: 'run_command', arguments: command },
        ]) {
          const response: Response = await fetch(bridge.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: asksDenied + 1, method: 'tools/call', params: operation }) });
          assert.equal(response.status, 200);
          const reply = await response.json() as any;
          assert.equal(reply.result.isError, true, `${operation.name} was executed in Ask mode.`);
          assert.match(JSON.stringify(reply.result.content), /Ask mode|ask mode|read.only|does not execute/i); asksDenied++;
        }
        content = 'Ask mode leaves the code unchanged and runs no verification command.';
      } else if (index < (mode === 'late' ? lateOperations : operations).length) {
        const operation = (mode === 'late' ? lateOperations : operations)[index];
        await operation.before?.();
        if (!loaded.has(operation.name)) {
          loaded.add(operation.name);
          call = { name: toolName(body, 'get_tool_info'), args: { mcp_server: connector, tool_name: operation.name } };
        } else {
          call = { name: toolName(body, 'call_tool'), args: { mcp_server: connector, tool_name: operation.name, input: operation.input } };
          index++;
        }
        advertised = true;
      } else content = mode === 'late' ? 'The last edit was saved after the passing test and has not been verified.' : 'Updated the code, observed the failing assertion, corrected it and reran the actual test successfully.';
      const base = { id: `agent-fixture-${index}-${loaded.size}-${mode}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (call) {
        emit(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0,
          id: `agent-call-${index}-${loaded.size}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] });
        emit(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        emit(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
        emit(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
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
    const baseUrl = `http://127.0.0.1:${runtimePort}`; await runtime.ensureRunning(baseUrl, AbortSignal.timeout(30_000));
    const setup = new TrueForgeHarness({ baseUrl });
    const configured = await setup.configureTrueFoundry({ gatewayUrl: `http://127.0.0.1:${providerPort}/agent-fixture/api/llm`, apiKey: 'fixture-only', modelId: 'fixture-account/agent-native' });
    await config.update('harnessUrl', baseUrl, vscode.ConfigurationTarget.Workspace);
    await config.update('model', configured.model, vscode.ConfigurationTarget.Workspace);
    await config.update('fallbackModels', [], vscode.ConfigurationTarget.Workspace);
    studio.newSession(); studio.setWorkMode('agent');
    await studio.run('Change the fixture value to 2. Run its actual test, fix any failing assertion and verify again.', undefined, vscode.Uri.file(project));
    assert.equal(studio.state.status, 'complete', `${studio.state.error}\n${providerErrors.map(error => error.message).join('\n')}`);
    assert.equal(advertised, true); assert.equal(index, operations.length);
    assert.equal(studio.state.workMode, 'agent'); assert.equal(await fs.readFile(sourcePath, 'utf8'), saveComment + corrected);
    assert.equal(saveParticipantRan, true, 'The native save participant did not run.');
    assert.deepEqual(studio.state.commands.map(command => [command.status, command.exitCode]), [['failed', 1], ['passed', 0]]);
    assert.equal(studio.state.plan.length, 3); assert.ok(studio.state.plan.every(step => step.status === 'completed'));
    assert.ok(studio.state.changedFiles.some(file => file.path === 'agent-value.cjs'));
    assert.ok(studio.state.events.some(event => event.type === 'command'));
    results.push('Actual Agent task applies/saves its first edit, runs node --test in the task workspace, observes exit 1, fixes current code, then saves and verifies exit 0 with real streamed output.');
    await studio.undo(); assert.equal(await fs.readFile(sourcePath, 'utf8'), original, 'Task undo did not restore the disk original across both applied batches.');
    results.push('Native save-participant edits remain part of subsequent batch snapshots; one Agent task undo restores the disk original across edit/test/fix/save batches.');

    studio.newSession(); studio.setWorkMode('agent'); mode = 'late'; index = 0; loaded.clear();
    await studio.run('Apply the correction, verify it with the real test, then make a later unverified edit and report that it needs verification.', undefined, vscode.Uri.file(project));
    assert.equal(studio.state.status, 'complete', `${studio.state.error}\n${providerErrors.map(error => error.message).join('\n')}`);
    assert.equal(index, lateOperations.length); assert.equal(await fs.readFile(sourcePath, 'utf8'), 'module.exports = () => 4;\n');
    assert.equal(studio.state.commands.length, 1); assert.equal(studio.state.commands[0].status, 'passed');
    assert.notEqual(studio.state.task.phase, 'verified', 'Passing tests were incorrectly reused for a newer applied edit.');
    assert.equal((studio.state.commands[0] as unknown as { stale?: boolean }).stale, true, 'The older passing command must be marked stale.');
    assert.equal((studio.state.task as unknown as { verification?: string }).verification, 'not_run', 'Current final code must require verification.');
    await studio.undo(); assert.equal(await fs.readFile(sourcePath, 'utf8'), original);
    results.push('A later saved edit invalidates the earlier passing command, marks it stale and keeps the final task unverified; task undo still restores the original.');

    studio.newSession(); studio.setWorkMode('ask'); mode = 'ask';
    await studio.run('Explain the fixture without changing files or running commands.', undefined, vscode.Uri.file(project));
    assert.equal(studio.state.status, 'complete', studio.state.error); assert.equal(asksDenied, 2);
    assert.equal(await fs.readFile(sourcePath, 'utf8'), original); assert.equal(studio.changes.list().length, 0); assert.equal(studio.state.commands.length, 0);
    assert.equal(providerErrors.length, 0, providerErrors.map(error => error.message).join('\n'));
    results.push('Ask mode rejects actual authenticated MCP edit and command requests; no file or command state changes.');
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nAgent runtime: ${runtimeLogs.slice(-6).join('\n')}\nProvider: ${providerErrors.map(item => item.message).join('\n')}`);
  } finally {
    saveParticipant.dispose();
    studio.cancel(); studio.newSession(); studio.setWorkMode(priorMode);
    await config.update('harnessUrl', priorUrl, vscode.ConfigurationTarget.Workspace);
    await config.update('model', priorModel, vscode.ConfigurationTarget.Workspace);
    await config.update('fallbackModels', priorFallbacks, vscode.ConfigurationTarget.Workspace);
    runtime.dispose(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await new Promise(resolve => setTimeout(resolve, 250)); await fs.rm(scratch, { recursive: true, force: true });
  }
}
