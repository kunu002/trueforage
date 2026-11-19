import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createServer, type Server, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir, homedir } from 'node:os';
import type { Studio } from '../src/extension';
import { LocalRuntime } from '../src/runtime';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}
function emit(res: ServerResponse, value: unknown): void { if (!res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`); }
function advertisedTool(body: any, wanted: string): string {
  const names = (body.tools ?? []).map((tool: any) => tool.function?.name).filter(Boolean) as string[];
  const name = names.find(item => item === wanted || item.endsWith(`__${wanted}`) || item.endsWith(`_${wanted}`));
  assert.ok(name, `Fixture tool ${wanted} is unavailable.`); return name;
}
interface Operation { name: string; input: Record<string, unknown>; before?: () => Promise<void> }

/** Keyless controlled model fixture; actual native editor changes, tests and undo. */
export async function run(): Promise<void> {
  const extensionPath = process.env.TRUEFORAGE_TEST_ROOT!;
  const work = path.join(extensionPath, 'video/work'); await fs.mkdir(work, { recursive: true });
  const stagePath = path.join(work, 'native-stage.json'); const continuePath = path.join(work, 'native-continue.json');
  const evidencePath = path.join(work, 'native-demo-evidence.json');
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri; assert.ok(workspace);
  const extension = vscode.extensions.getExtension<Studio>('trueforage-team.trueforage'); assert.ok(extension);
  const studio = await extension.activate();
  const node = await fs.realpath(process.env.TRUEFORAGE_EXTERNAL_NODE ?? path.join(homedir(), '.local/bin/node'));
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'trueforage-video-runtime-'));
  const runtime = new LocalRuntime({ extensionPath, storagePath: scratch, nodePath: node });
  const appPath = path.join(workspace.fsPath, 'app.cjs'); const testPath = path.join(workspace.fsPath, 'app.test.cjs');
  const originalApp = await fs.readFile(appPath, 'utf8'); const originalTests = await fs.readFile(testPath, 'utf8');
  const originalDocs = await fs.readFile(path.join(workspace.fsPath, 'README.md'), 'utf8');
  const fixedApp = originalApp.replace('Math.min(min, Math.max(max, value))', 'Math.min(max, Math.max(min, value))');
  const observations: string[] = []; const chapters: { stage: string; at: string }[] = [];
  let mode: 'agent' | 'review' | 'ask' | 'cancel' = 'agent';
  let cursor = 0; const loaded = new Set<string>(); let callId = 0;
  const errors: string[] = [];
  const agentPrompt = 'Fix the clamp bounds. Inspect the repository, show a plan, run the existing tests, fix the failure and verify. Keep the original assertions unchanged; use node --test without installing packages.';
  const stage = async (name: string, title: string) => {
    chapters.push({ stage: name, at: new Date().toISOString() });
    await fs.writeFile(stagePath, JSON.stringify({ stage: name, title, status: 'ready', timestamp: new Date().toISOString(),
      model: 'controlled-fixture/demo', realModelUsed: false, cdpPort: 9343,
      continueFile: continuePath, workMode: studio.state.workMode, sessionId: studio.state.sessionId,
      exactPrompt: studio.state.prompt || agentPrompt, plan: studio.state.plan,
      hunks: studio.changes.list().map(hunk => ({ id: hunk.id, path: hunk.path, status: hunk.status })),
      files: studio.state.context.map(entry => ({ path: entry.path, startLine: entry.startLine, endLine: entry.endLine, reason: entry.reason })),
      commands: studio.state.commands.map(command => ({ id: command.id, executable: command.executable, args: command.args, status: command.status, exitCode: command.exitCode })) }, null, 2));
    console.log(`TRUEFORAGE_DEMO_STAGE ${name}`);
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      try { if (JSON.parse(await fs.readFile(continuePath, 'utf8')).stage === name) return; } catch {}
      await pause(500);
    }
    throw new Error(`Capture stage ${name} was not continued within five minutes.`);
  };
  const plan = (phase: number) => ({ steps: ['Inspect implementation and tests', 'Run the baseline test', 'Fix and save the clamp', 'Rerun and verify'].map((step, index) => ({ step,
    status: phase > index ? 'completed' : phase === index ? 'in_progress' : 'pending' })) });
  const command = { executable: 'node', args: ['--test', 'app.test.cjs'], reason: 'Run the actual Node built-in clamp tests in this workspace.' };
  const agentOperations: Operation[] = [
    { name: 'update_plan', input: plan(0) }, { name: 'list_files', input: {} },
    { name: 'read_file', input: { path: 'app.cjs', reason: 'The exported clamp function owns the bounds calculation.' } },
    { name: 'search_context', input: { query: 'clamp minimum maximum bounds implementation tests documentation' } },
    { name: 'update_plan', input: plan(1) },
    { name: 'run_command', input: command, before: () => stage('agent-context', 'Visible plan and selected source evidence') },
    { name: 'update_plan', input: plan(2) },
    { name: 'propose_edit', input: { path: 'app.cjs', oldText: 'Math.min(min, Math.max(max, value))', newText: 'Math.min(max, Math.max(min, value))',
      reason: 'The failing inside/above-bound assertions show the minimum and maximum are reversed.' }, before: async () => {
      assert.equal(studio.state.commands[0]?.exitCode, 1); assert.match(studio.state.commands[0].stdout, /fail|not ok/i);
      observations.push('The actual baseline Node test failed with exit 1.'); await stage('agent-baseline-failed', 'Real baseline failure and output');
    } },
    { name: 'apply_changes', input: {} }, { name: 'update_plan', input: plan(3) },
    { name: 'run_command', input: command }, { name: 'update_plan', input: plan(4) },
  ];
  const reviewOperations: Operation[] = [
    { name: 'search_context', input: { query: 'clamp documentation test inclusive bounds' } },
    { name: 'propose_edit', input: { path: 'app.cjs', oldText: fixedApp, newText: '/** Clamp a value to inclusive minimum and maximum bounds. */\n' + fixedApp, reason: 'Document the verified function at its definition.' } },
    { name: 'propose_edit', input: { path: 'app.test.cjs', oldText: originalTests, newText: originalTests + '\ntest("equal bounds", () => assert.equal(clamp(9, 4, 4), 4));\n', reason: 'Cover a useful equal-bound edge case.' } },
    { name: 'propose_edit', input: { path: 'README.md', oldText: originalDocs, newText: originalDocs + '\nThe clamp also supports equal minimum and maximum bounds.\n', reason: 'Offer a matching documentation update for review.' } },
    { name: 'review_changes', input: {} },
  ];
  const askOperations: Operation[] = [{ name: 'read_file', input: { path: 'app.cjs', reason: 'Explain the current clamp without edits or commands.' } }];
  const provider = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); assert.equal(req.headers.authorization, 'Bearer fixture-only');
      const bridge = (studio as unknown as { bridge?: { url: string } }).bridge; assert.ok(bridge);
      const connector = `trueforage-${process.pid}-${new URL(bridge.url).port}`;
      const base = { id: `controlled-${++callId}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'demo' };
      if (mode === 'cancel') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const text = 'This is the controlled local model fixture streaming through the real TrueForge session. I am inspecting the request before proposing any change. The workspace remains unchanged until an edit tool applies a batch. '.repeat(20);
        for (const word of text.split(' ')) {
          if (res.destroyed) return; emit(res, { ...base, choices: [{ index: 0, delta: { content: word + ' ' }, finish_reason: null }] }); await pause(120);
        }
        emit(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }); res.end('data: [DONE]\n\n'); return;
      }
      const operations = mode === 'agent' ? agentOperations : mode === 'review' ? reviewOperations : askOperations;
      let call: { name: string; args: Record<string, unknown> } | undefined;
      if (cursor < operations.length) {
        const operation = operations[cursor];
        if (!loaded.has(operation.name)) {
          loaded.add(operation.name); call = { name: advertisedTool(body, 'get_tool_info'), args: { mcp_server: connector, tool_name: operation.name } };
        } else {
          await operation.before?.(); cursor++;
          call = { name: advertisedTool(body, 'call_tool'), args: { mcp_server: connector, tool_name: operation.name, input: operation.input } };
        }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (call) {
        emit(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `controlled-tool-${callId}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] });
        emit(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        const content = mode === 'agent' ? 'Fixed the reversed clamp bounds and saved app.cjs. The baseline failed; the rerun passed all 3 original tests with exit 0. This walkthrough uses a controlled local model fixture; the editor edits and test results are real.'
          : mode === 'review' ? 'Applied the accepted implementation comment and edge-case test. The documentation hunk was rejected and stayed unchanged. Both accepted edits are one undoable editor transaction.'
            : 'Math.max first enforces the minimum; Math.min then enforces the maximum. Ask mode only inspects source. No files were changed and no commands were run.';
        for (const word of content.split(' ')) { emit(res, { ...base, choices: [{ index: 0, delta: { content: word + ' ' }, finish_reason: null }] }); await pause(30); }
        emit(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(error) } })); else res.end();
    }
  });
  const setMode = (next: typeof mode) => { mode = next; cursor = 0; loaded.clear(); studio.newSession(); studio.setWorkMode(next === 'cancel' ? 'agent' : next); };
  const showSource = async () => { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(appPath)), { preview: false }); await studio.open(); };
  try {
    const providerPort = await listen(provider); const reservation = createServer(); const runtimePort = await listen(reservation);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const baseUrl = `http://127.0.0.1:${runtimePort}`; await runtime.ensureRunning(baseUrl);
    const { TrueForge } = await import('@truefoundry/trueforge-sdk');
    const setup = new TrueForge({ baseUrl, maxRetries: 0 });
    await setup.settings.modelProviders.createOrUpdate({ manifest: { type: 'custom', name: 'controlled-fixture',
      baseUrl: `http://127.0.0.1:${providerPort}/fixture`, auth: { apiKey: 'fixture-only' },
      models: [{ name: 'demo', modelId: 'demo', properties: {} }] } });
    const configured = { model: 'controlled-fixture/demo' };
    const config = vscode.workspace.getConfiguration('trueforage');
    await config.update('harnessUrl', baseUrl, vscode.ConfigurationTarget.Workspace); await config.update('model', configured.model, vscode.ConfigurationTarget.Workspace);
    await config.update('fallbackModels', [], vscode.ConfigurationTarget.Workspace);
    for (const [key, value] of Object.entries({ 'window.zoomLevel': 0.5, 'editor.fontSize': 16, 'workbench.startupEditor': 'none' })) {
      const split = key.indexOf('.'); await vscode.workspace.getConfiguration(key.slice(0, split)).update(key.slice(split + 1), value, vscode.ConfigurationTarget.Global);
    }
    for (const command of ['workbench.action.closeAllEditors', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) { try { await vscode.commands.executeCommand(command); } catch {} }
    setMode('agent'); await showSource(); await stage('agent-ready', 'Controlled fixture: native Agent workflow on a broken clamp');
    await studio.run(agentPrompt, undefined, workspace);
    assert.equal(studio.state.status, 'complete', studio.state.error); assert.equal(await fs.readFile(appPath, 'utf8'), fixedApp);
    assert.equal(await fs.readFile(testPath, 'utf8'), originalTests); assert.deepEqual(studio.state.commands.map(item => item.exitCode), [1, 0]);
    observations.push('The implementation was saved, original tests were unchanged, and all 3 rerun tests passed with exit 0.');
    await showSource(); await stage('agent-fixed-verified', 'Saved fix, completed plan and real passing tests');

    setMode('review');
    const review = studio.run('Document the clamp function, add an equal-bound test and offer a matching README update for individual hunk review.', undefined, workspace);
    const reviewDeadline = Date.now() + 30_000;
    while (!(String(studio.state.status) === 'review' && studio.changes.list().length === 3)) { if (Date.now() > reviewDeadline || String(studio.state.status) === 'error') throw new Error(studio.state.error || 'Review fixture timed out.'); await pause(100); }
    await studio.showDiff(studio.changes.list()[0].id); await stage('review-hunks', 'Three native hunks wait for individual decisions');
    for (const hunk of studio.changes.list()) { studio.review(hunk.id, hunk.path === 'README.md' ? 'rejected' : 'accepted'); await pause(600); }
    await studio.apply(); await review;
    assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.file(appPath))).getText(), '/** Clamp a value to inclusive minimum and maximum bounds. */\n' + fixedApp);
    assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace, 'README.md'))).getText(), originalDocs);
    observations.push('Review accepted code and test hunks, rejected README, and applied accepted editor buffers in one transaction.');
    await stage('review-applied', 'Accepted subset applied; rejected documentation unchanged');
    await studio.undo(); assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.file(appPath))).getText(), fixedApp);
    assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.file(testPath))).getText(), originalTests);
    observations.push('Undo task restored both accepted Review buffers to their pre-review contents.');
    await showSource(); await stage('review-undone', 'Undo restores the accepted Review changes');

    setMode('ask'); await studio.run('Explain the current clamp without editing files or running commands.', undefined, workspace);
    assert.equal(studio.state.commands.length, 0); assert.equal(studio.changes.list().length, 0); assert.equal(await fs.readFile(appPath, 'utf8'), fixedApp);
    observations.push('Ask read source without changing files or executing commands.'); await stage('ask-readonly', 'Read-only explanation in Ask mode');
    setMode('cancel'); const cancelledRun = studio.run('Inspect another change and explain your approach before editing.', undefined, workspace);
    const streamDeadline = Date.now() + 15_000;
    while (studio.state.stream.length < 40) { if (Date.now() > streamDeadline) throw new Error('Cancellation stream did not start.'); await pause(100); }
    await stage('cancel-live', 'A real streamed session can be cancelled before edits'); studio.cancel(); await cancelledRun;
    assert.equal(studio.state.status, 'cancelled'); assert.equal(studio.changes.list().length, 0); assert.equal(await fs.readFile(appPath, 'utf8'), fixedApp);
    observations.push('Cancelling the live fixture stream discarded unapplied work and left the saved implementation intact.');
    assert.equal(errors.length, 0, errors.join('\n'));
    await fs.writeFile(evidencePath, JSON.stringify({ status: 'passed', date: new Date().toISOString(), model: configured.model, realModelUsed: false,
      provider: 'controlled local deterministic fixture', actualEditorEdits: true, actualTestExitCodes: [1, 0], observations, chapters, errors }, null, 2));
    await stage('finished', 'Native walkthrough complete; evidence saved');
  } catch (error) {
    await fs.writeFile(evidencePath, JSON.stringify({ status: 'failed', realModelUsed: false, error: error instanceof Error ? error.message : String(error), observations, chapters, errors }, null, 2));
    throw error;
  } finally {
    studio.cancel(); runtime.dispose(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
