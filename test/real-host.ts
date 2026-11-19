import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import type { Studio } from '../src/extension';

function sanitize(text: string): string {
  return text.replace(/\bAIza[0-9A-Za-z_-]+/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/((?:[?&](?:key|api_key|token)|api[_ -]?key|access[_ -]?token|authorization)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,}]+)/gi, '$1[redacted]');
}

async function resolveExternalNode(): Promise<string> {
  const candidates = [process.env.TRUEFORAGE_EXTERNAL_NODE, path.join(homedir(), '.local/bin/node'),
    ...String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'))];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await fs.access(candidate); return await fs.realpath(candidate); } catch { /* Continue to an external Node installation. */ }
  }
  throw new Error('No external Node executable was found for independent test verification.');
}

async function independentlyVerify(node: string, cwd: string): Promise<{ exitCode: number | string; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(node, ['--test', 'app.test.cjs'], { cwd, shell: false, timeout: 30_000, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      resolve({ exitCode: error ? (error as NodeJS.ErrnoException).code ?? 1 : 0, stdout: sanitize(stdout), stderr: sanitize(stderr) });
    });
  });
}

/** Genuine configured model smoke check. Provider credentials stay in the existing local harness. */
export async function run(): Promise<void> {
  const root = process.env.TRUEFORAGE_TEST_ROOT;
  assert.ok(root, 'TRUEFORAGE_TEST_ROOT must identify the extension repository.');
  const model = process.env.TRUEFORAGE_REAL_MODEL ?? 'google-gemini/gemini-3-1-flash-lite';
  const baseUrl = process.env.TRUEFORAGE_REAL_HARNESS_URL ?? 'http://127.0.0.1:8790';
  const artifactPath = path.join(root, 'artifacts/real-model-smoke.json');
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, 'The real-model smoke check needs its isolated fixture workspace.');
  const extension = vscode.extensions.getExtension<Studio>('trueforage-team.trueforage');
  assert.ok(extension, 'The TrueForage extension must be loaded in the native editor.');
  const studio = await extension.activate();
  const appPath = path.join(workspace.fsPath, 'app.cjs');
  const testsPath = path.join(workspace.fsPath, 'app.test.cjs');
  const original = await fs.readFile(appPath, 'utf8');
  const originalTests = await fs.readFile(testsPath, 'utf8');
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let verification: Awaited<ReturnType<typeof independentlyVerify>> | undefined;
  let runningTask: Promise<void> | undefined;
  let taskTimedOut = false;
  const commandRecords = () => studio.state.commands.map(command => ({ executable: command.executable, args: command.args,
    status: command.status, exitCode: command.exitCode, durationMs: command.durationMs }));
  const writeArtifact = async (value: Record<string, unknown>) => {
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    const text = JSON.stringify(value, (_key, value) => typeof value === 'string' ? sanitize(value) : value, 2);
    await fs.writeFile(artifactPath, text + '\n');
  };
  try {
    const config = vscode.workspace.getConfiguration('trueforage');
    await config.update('harnessUrl', baseUrl, vscode.ConfigurationTarget.Workspace);
    await config.update('model', model, vscode.ConfigurationTarget.Workspace);
    await config.update('fallbackModels', [], vscode.ConfigurationTarget.Workspace);
    studio.newSession(); studio.setWorkMode('agent'); await studio.openEditor();
    runningTask = studio.run('Fix the clamp function so values below the minimum become the minimum, values inside the bounds stay unchanged, and values above the maximum become the maximum. Discover the files yourself. Keep the existing test assertions unchanged. Use the existing Node built-in tests, run them with node --test, fix any failure and report the actual result. Do not install dependencies.', undefined, workspace);
    const bounded = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => { taskTimedOut = true; studio.cancel(); reject(new Error('The genuine model smoke task exceeded its 120-second deadline.')); }, 120_000);
    });
    await Promise.race([runningTask, bounded]);
    if (deadline) { clearTimeout(deadline); deadline = undefined; }
    assert.equal(studio.state.status, 'complete', studio.state.error || 'The genuine model task did not complete.');
    assert.notEqual(await fs.readFile(appPath, 'utf8'), original, 'The assistant did not persist an implementation change.');
    assert.equal(await fs.readFile(testsPath, 'utf8'), originalTests, 'The assistant changed the original test assertions.');
    assert.ok(studio.state.commands.some(command => command.status === 'passed' && command.exitCode === 0 &&
      (command.args.includes('--test') || command.args.includes('test'))), 'The assistant did not record a real passing test command.');
    verification = await independentlyVerify(await resolveExternalNode(), workspace.fsPath);
    assert.equal(verification.exitCode, 0, verification.stdout + '\n' + verification.stderr);
    await writeArtifact({ status: 'passed', date: new Date().toISOString(), model, sessionId: studio.state.sessionId,
      commands: commandRecords(), filesChanged: studio.state.changedFiles.map(file => file.path), response: studio.state.stream,
      independentVerification: verification, originalTestsUnchanged: true, implementationChanged: true,
      taskCompleted: true, taskTimedOut: false, finalResponseReceived: Boolean(studio.state.stream.trim()),
      independentlyVerified: true, verified: true, realModelUsed: true });
    console.log(`TRUEFORAGE_REAL_MODEL_OK model=${model} session=${studio.state.sessionId} artifact=${artifactPath}`);
    await studio.openEditor();
    await new Promise(resolve => setTimeout(resolve, process.env.TRUEFORAGE_REAL_KEEP_VISIBLE_MS ? Number(process.env.TRUEFORAGE_REAL_KEEP_VISIBLE_MS) : 10_000));
  } catch (error) {
    if (deadline) { clearTimeout(deadline); deadline = undefined; }
    const taskCompleted = !taskTimedOut && studio.state.status === 'complete';
    // A response timeout does not establish whether already-saved edits are
    // correct. Stop the task, allow its owned cleanup to settle, and inspect the
    // saved workspace independently without another model request.
    if (studio.state.busy) studio.cancel();
    if (runningTask) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([runningTask.catch(() => undefined), new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 2_000); })]);
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
    let originalTestsUnchanged: boolean | undefined;
    let implementationChanged: boolean | undefined;
    let independentVerificationError: string | undefined;
    try {
      originalTestsUnchanged = await fs.readFile(testsPath, 'utf8') === originalTests;
      implementationChanged = await fs.readFile(appPath, 'utf8') !== original;
      verification ??= await independentlyVerify(await resolveExternalNode(), workspace.fsPath);
    } catch (verificationError) {
      independentVerificationError = verificationError instanceof Error ? verificationError.message : String(verificationError);
    }
    const independentlyVerified = verification?.exitCode === 0 && originalTestsUnchanged === true && implementationChanged === true;
    await writeArtifact({ status: 'failed', date: new Date().toISOString(), model, sessionId: studio.state.sessionId,
      commands: commandRecords(), filesChanged: studio.state.changedFiles.map(file => file.path), response: studio.state.stream,
      error: error instanceof Error ? error.message : String(error), independentVerification: verification,
      independentVerificationError, originalTestsUnchanged, implementationChanged,
      taskCompleted, taskTimedOut, finalResponseReceived: Boolean(studio.state.stream.trim()),
      independentlyVerified, verified: false, realModelUsed: true });
    throw new Error(sanitize(error instanceof Error ? error.message : String(error)));
  } finally { if (deadline) clearTimeout(deadline); }
}
