import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Studio } from '../src/extension';
import type { Workspace } from '../src/workspace';
import { runLiveEditorChecks } from './live-host';
import { runAgentEditorChecks } from './agent-host';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function run(): Promise<void> {
  const results: string[] = [];
  const extension = vscode.extensions.getExtension<Studio>('trueforage-team.trueforage');
  assert.ok(extension, 'Extension must be discovered by VS Code');
  const studio = await extension.activate();
  assert.ok((await vscode.commands.getCommands()).includes('trueforage.inline'));
  await studio.demo();
  assert.equal(studio.state.status, 'review');
  assert.equal(studio.state.mode, 'demo');
  assert.equal(studio.changes.list().length, 4);
  assert.equal(new Set(studio.changes.list().map(hunk => hunk.path)).size, 3);
  results.push('Extension activates; scripted playground streams and stages 4 hunks in 3 files.');
  // Use the controller's isolated fixture workspace to inspect actual editor buffers.
  let workspace = (studio as unknown as { workspace: Workspace }).workspace;
  const before = new Map<string, string>();
  for (const hunk of studio.changes.list()) before.set(hunk.path, (await workspace.read(hunk.path)).content);
  const hunks = studio.changes.list();
  await studio.showDiff(hunks[0].id);
  const proposals = vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'trueforage' && doc.uri.path.startsWith('/after/'));
  assert.ok(proposals.length > 0, 'Native diff proposal document opened');
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', proposals[0].uri);
  assert.ok(lenses?.some(lens => lens.command?.command === 'trueforage.acceptHunk'), 'Native diff exposes per-hunk accept action');
  await vscode.commands.executeCommand('trueforage.acceptHunk', proposals[0].uri);
  assert.equal(studio.changes.list().find(hunk => hunk.id === hunks[0].id)?.status, 'accepted', 'Editor title action resolves the active hunk from its resource URI');
  assert.equal((await workspace.read('src/debug.py')).content, before.get('src/debug.py'), 'Diff must not write files');
  results.push('Native vscode.diff opens read-only proposal with accept/reject CodeLens; original stays intact.');
  for (const hunk of hunks) studio.review(hunk.id, hunk.path.startsWith('docs/') ? 'rejected' : 'accepted');
  const applying = studio.apply();
  await assert.rejects(() => studio.apply(), /Wait for the current apply/);
  assert.throws(() => studio.review(hunks[0].id, 'rejected'), /Wait for the current apply/);
  await assert.rejects(() => studio.demo(), /Wait for the current apply/);
  await applying;
  assert.equal(studio.changes.list().find(hunk => hunk.id === hunks[0].id)?.status, 'accepted', 'An in-flight transaction cannot have its accepted set changed');
  const applied = (await workspace.read('src/debug.py')).content;
  assert.match(applied, /"off", "n"/);
  assert.match((await workspace.read('test/test_debug.py')).content, /"OFF"/);
  assert.equal((await workspace.read('docs/debug.md')).content, before.get('docs/debug.md'));
  assert.equal(studio.state.applied, true);
  results.push('Accepted subset applies across 2 real editor buffers; rapid Apply, review changes and a new playground cannot race the transaction.');

  await vscode.window.showTextDocument((await workspace.read('src/debug.py')).doc!);
  await vscode.commands.executeCommand('undo'); await wait(150);
  assert.equal((await workspace.read('src/debug.py')).content, before.get('src/debug.py'));
  assert.equal((await workspace.read('test/test_debug.py')).content, before.get('test/test_debug.py'));
  results.push('One native VS Code undo restores both changed files.');
  await vscode.commands.executeCommand('redo'); await wait(150);
  assert.equal((await workspace.read('src/debug.py')).content, applied);
  const undoing = studio.undo();
  await assert.rejects(() => studio.undo(), /Wait for the current undo/);
  await undoing;
  for (const [file, original] of before) assert.equal((await workspace.read(file)).content, original);
  results.push('Native redo and explicit TrueForage undo restore the expected workspace; rapid Undo is serialized.');

  const live = studio.demo(); await wait(160); studio.cancel(); await live;
  workspace = (studio as unknown as { workspace: Workspace }).workspace;
  assert.equal(studio.state.status, 'cancelled');
  assert.equal(studio.changes.list().length, 0);
  for (const [file, original] of before) assert.equal((await workspace.read(file)).content, original);
  results.push('Cancellation during fixture streaming discards unapplied hunks and preserves every file.');

  await studio.demo();
  workspace = (studio as unknown as { workspace: Workspace }).workspace;
  for (const hunk of studio.changes.list()) studio.review(hunk.id, 'accepted');
  // Pause preparation before its first file read finishes. Cancelling here must
  // invalidate the captured review and never dispatch an editor transaction.
  const originalRead = workspace.read.bind(workspace);
  let releaseRead!: () => void;
  const waitingForRead = new Promise<void>(resolve => { releaseRead = resolve; });
  workspace.read = async (...args) => { await waitingForRead; return originalRead(...args); };
  try {
    const pendingApply = studio.apply();
    studio.cancel(); releaseRead();
    await assert.rejects(pendingApply, /cancelled/i);
  } finally { releaseRead(); workspace.read = originalRead; }
  assert.equal(studio.state.status, 'cancelled');
  assert.equal(studio.changes.list().length, 0);
  for (const [file, original] of before) assert.equal((await workspace.read(file)).content, original);
  results.push('Cancellation during apply preparation invalidates the reviewed snapshot before any editor buffer changes.');

  await studio.demo();
  workspace = (studio as unknown as { workspace: Workspace }).workspace;
  for (const hunk of studio.changes.list()) studio.review(hunk.id, 'accepted');
  const read = await workspace.read('src/debug.py');
  const external = new vscode.WorkspaceEdit(); external.insert(read.doc!.uri, new vscode.Position(0, 0), '# edited during review\n');
  await vscode.workspace.applyEdit(external);
  await assert.rejects(() => studio.apply(), /Stale/);
  assert.equal((await workspace.read('test/test_debug.py')).content, before.get('test/test_debug.py'));
  results.push('A stale file aborts the whole accepted transaction without changing another file.');
  await vscode.window.showTextDocument(read.doc!); await vscode.commands.executeCommand('undo');
  studio.cancel();

  const root = process.env.TRUEFORAGE_TEST_ROOT;
  assert.ok(root, 'Test root must identify the development extension.');
  await runLiveEditorChecks(studio, root, results);
  await runAgentEditorChecks(studio, root, results);

  // Leave a polished review panel briefly visible for manual feedback during the test.
  await studio.demo();
  await studio.showDiff(studio.changes.list()[1].id);
  if (root) {
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    await fs.writeFile(path.join(root, 'artifacts/host-results.json'), JSON.stringify({ date: new Date().toISOString(), vscode: vscode.version, results, realModelUsed: false }, null, 2));
  }
  console.log(`TRUEFORAGE_HOST_OK\n${results.join('\n')}`);
  await wait(1200);
}
