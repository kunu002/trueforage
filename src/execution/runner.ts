import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

export const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;
export type CommandStream = 'stdout' | 'stderr';
export interface ExecuteCommandOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  /** Host-supplied environment overrides; callers must not expose this to model tool input. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Receives retained, decoded output as it arrives, subject to the shared 1 MB cap. */
  onOutput?: (chunk: string, stream: CommandStream) => void;
}
export interface CommandResult {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal?: NodeJS.Signals;
  status: 'passed' | 'failed' | 'cancelled' | 'timed_out';
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

function prefixWithinBytes(text: string, budget: number): string {
  if (Buffer.byteLength(text, 'utf8') <= budget) return text;
  let bytes = 0; let offset = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > budget) break;
    bytes += size; offset += character.length;
  }
  return text.slice(0, offset);
}

/** Executes one argv array in a real working directory, without a shell or OS sandbox. */
export async function executeCommand(options: ExecuteCommandOptions): Promise<CommandResult> {
  if (!options.executable || typeof options.executable !== 'string' || options.executable.includes('\0') ||
    !Array.isArray(options.args) || options.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
    !options.cwd || typeof options.cwd !== 'string' || options.cwd.includes('\0')) {
    throw new TypeError('Command requires an executable, a string argument array and a working directory without NUL characters.');
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new TypeError('Command timeout must be a positive finite number.');
  const timeoutMs = Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1, Math.floor(options.timeoutMs ?? MAX_COMMAND_TIMEOUT_MS)));
  const started = performance.now();
  const result: CommandResult = { id: randomUUID(), executable: options.executable, args: [...options.args], cwd: options.cwd,
    exitCode: null, status: 'failed', stdout: '', stderr: '', durationMs: 0, truncated: false };
  if (options.signal?.aborted) { result.status = 'cancelled'; return result; }
  return new Promise<CommandResult>(resolve => {
    let child: ChildProcess;
    let bytes = 0;
    let stopped: 'cancelled' | 'timed_out' | undefined;
    let closed = false;
    let settled = false;
    let spawnFailed = false;
    let cleanupFinished = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stdoutDecoder = new StringDecoder('utf8'); const stderrDecoder = new StringDecoder('utf8');
    const append = (text: string, stream: CommandStream) => {
      const retained = prefixWithinBytes(text, MAX_COMMAND_OUTPUT_BYTES - bytes);
      if (retained.length < text.length) result.truncated = true;
      if (!retained) return;
      bytes += Buffer.byteLength(retained, 'utf8'); result[stream] += retained;
      try { options.onOutput?.(retained, stream); } catch { /* Presentation failures must not change the command result. */ }
    };
    const finish = () => {
      if (settled || !closed || !cleanupFinished) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener('abort', abort);
      result.durationMs = Math.round(performance.now() - started);
      result.status = stopped ?? (result.exitCode === 0 ? 'passed' : 'failed');
      resolve(result);
    };
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { /* The owned process group may already have exited. */ }
    };
    const stop = (reason: 'cancelled' | 'timed_out') => {
      if (settled || stopped) return;
      stopped = reason; cleanupFinished = false;
      if (process.platform === 'win32' && child.pid) {
        // taskkill /T terminates descendants as well as the process started here.
        const terminator = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        terminator.once('error', () => killGroup('SIGKILL'));
        terminator.once('close', () => { cleanupFinished = true; finish(); });
        forceKill = setTimeout(() => { killGroup('SIGKILL'); cleanupFinished = true; finish(); }, 1_000);
      } else {
        killGroup('SIGTERM');
        // Keep this cleanup even when the leader exits early: an inherited child
        // may ignore SIGTERM while retaining the owned process-group identity.
        forceKill = setTimeout(() => { killGroup('SIGKILL'); cleanupFinished = true; finish(); }, 250);
      }
    };
    const abort = () => stop('cancelled');
    try {
      child = spawn(options.executable, [...options.args], { cwd: options.cwd, env: { ...process.env, ...options.env }, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      append(error instanceof Error ? error.message : String(error), 'stderr'); closed = true; finish(); return;
    }
    child.stdout?.on('data', (chunk: Buffer) => append(stdoutDecoder.write(chunk), 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => append(stderrDecoder.write(chunk), 'stderr'));
    child.once('error', error => { spawnFailed = true; append(error.message, 'stderr'); });
    child.once('close', (code, signal) => {
      append(stdoutDecoder.end(), 'stdout'); append(stderrDecoder.end(), 'stderr');
      result.exitCode = spawnFailed ? null : code; if (signal) result.signal = signal;
      closed = true; finish();
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    timeout = setTimeout(() => stop('timed_out'), timeoutMs);
  });
}
