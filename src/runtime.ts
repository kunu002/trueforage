import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { constants } from 'node:fs';

const PINNED_RUNTIME = '@truefoundry/trueforge@0.183.1';
const MANUAL_START = `npx --yes ${PINNED_RUNTIME} --port 8790`;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface LocalRuntimeOptions {
  extensionPath: string;
  storagePath: string;
  /** External Node executable. VS Code's Electron executable is never used. */
  nodePath?: string;
  onLog?: (text: string) => void;
}

function cancelled(): Error {
  return Object.assign(new Error('Local TrueForge startup cancelled.'), { name: 'AbortError' });
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

function redact(text: string): string {
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|authorization)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}]+)/gi, '$1[redacted]');
}

export function supportsTrueForgeNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]); const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 14);
}

async function executable(file: string): Promise<boolean> {
  try { await fs.access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; }
  catch { return false; }
}

function candidateDirectories(): string[] {
  return [...new Set([
    ...(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean),
    path.join(homedir(), '.local', 'bin'), path.join(homedir(), '.volta', 'bin'),
    ...(process.env.NVM_BIN ? [process.env.NVM_BIN] : []),
  ])];
}

async function nodeVersion(file: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, ['--version'], { timeout: 3_000, maxBuffer: 1_024, windowsHide: true, signal }, (error, stdout) => {
      if (signal?.aborted) reject(cancelled());
      else if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

async function findNode(explicit: string | undefined, signal?: AbortSignal): Promise<string> {
  const directories = candidateDirectories();
  const candidates = explicit
    ? (path.isAbsolute(explicit) || explicit.includes(path.sep) ? [explicit] : directories.map(directory => path.join(directory, explicit)))
    : directories.map(directory => path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'));
  let detected: string | undefined;
  for (const candidate of [...new Set(candidates)]) {
    assertActive(signal);
    if (!await executable(candidate)) continue;
    try {
      const real = await fs.realpath(candidate);
      const version = await nodeVersion(real, signal);
      if (supportsTrueForgeNode(version)) return real;
      detected = version;
    } catch (error) { assertActive(signal); if (explicit) detected = error instanceof Error ? error.message : String(error); }
  }
  throw new Error(`TrueForge needs an external Node.js 22.14 or newer${detected ? ` (found ${detected})` : ''}. Install Node.js or set trueforage.nodePath, then reconnect. You can also start it manually: ${MANUAL_START}`);
}

/** Reuse the runtime's external Node discovery for workspace commands. */
export async function resolveExternalNode(explicit?: string, signal?: AbortSignal): Promise<string> {
  return findNode(explicit, signal);
}

async function findNpx(node: string): Promise<string | undefined> {
  const directories = candidateDirectories();
  const candidates = [
    path.resolve(path.dirname(node), '../lib/node_modules/npm/bin/npx-cli.js'),
    path.resolve(path.dirname(node), 'node_modules/npm/bin/npx-cli.js'),
  ];
  for (const directory of directories) {
    const command = path.join(directory, process.platform === 'win32' ? 'npx' : 'npx');
    try {
      const real = await fs.realpath(command);
      if (real.endsWith('npx-cli.js')) candidates.push(real);
      candidates.push(path.resolve(directory, '../lib/node_modules/npm/bin/npx-cli.js'));
    } catch { /* Continue to the next external Node installation. */ }
  }
  for (const candidate of [...new Set(candidates)]) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* Missing npm installation. */ }
  }
  return undefined;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  assertActive(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); reject(cancelled()); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** A response, including HTTP 401, proves a server is already listening. */
async function online(baseUrl: URL, signal?: AbortSignal): Promise<boolean> {
  assertActive(signal);
  try {
    const response = await fetch(new URL('/api/v1/models', baseUrl), {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_000)]) : AbortSignal.timeout(1_000),
      redirect: 'manual',
    });
    await response.body?.cancel();
    return true;
  } catch { assertActive(signal); return false; }
}

/** Owns only the local process it starts. Existing user-managed servers are reused. */
export class LocalRuntime {
  private child?: ChildProcess;
  private startup?: { url: string; controller: AbortController; promise: Promise<void> };
  private disposed = false;
  private readonly shutdownTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly options: LocalRuntimeOptions) {}

  async ensureRunning(baseUrl: string, signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('The local TrueForge runtime manager is disposed.');
    assertActive(signal);
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !loopbackHosts.has(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Use a loopback HTTP(S) root URL for TrueForge, for example http://127.0.0.1:8790.');
    }
    const available = await online(url, signal);
    if (this.disposed) throw new Error('The local TrueForge runtime manager is disposed.');
    if (available) return;
    if (url.protocol !== 'http:' || url.hostname === '[::1]' || !url.port) {
      throw new Error(`Could not reach TrueForge at ${url.origin}. Automatic startup uses a loopback HTTP URL with an explicit port, such as http://127.0.0.1:8790. Start it manually if needed: ${MANUAL_START}`);
    }
    assertActive(signal);
    if (this.startup) {
      if (this.startup.url !== url.origin) throw new Error('Another local TrueForge startup is already in progress.');
      const abort = () => this.startup?.controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try { await this.startup.promise; } finally { signal?.removeEventListener('abort', abort); }
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const startup = { url: url.origin, controller, promise: Promise.resolve() };
    this.startup = startup;
    startup.promise = this.start(url, controller.signal);
    try { await startup.promise; }
    finally {
      signal?.removeEventListener('abort', abort);
      if (this.startup === startup) this.startup = undefined;
    }
  }

  private log(text: string): void {
    try { this.options.onLog?.(redact(text).trimEnd()); } catch { /* A closed editor output must not keep the runtime alive. */ }
  }

  private async start(url: URL, signal: AbortSignal): Promise<void> {
    let child = this.child;
    let output = '';
    let failure: Error | undefined;
    try {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        const node = await findNode(this.options.nodePath, signal);
        const cli = path.join(this.options.extensionPath, 'node_modules', '@truefoundry', 'trueforge', 'dist', 'cli.js');
        let args: string[];
        try { await fs.access(cli); args = [cli, '--port', url.port]; }
        catch {
          const npx = await findNpx(node);
          if (!npx) throw new Error(`npm/npx was not found beside Node.js. Install Node.js with npm, then reconnect, or run: ${MANUAL_START}`);
          args = [npx, '--yes', PINNED_RUNTIME, '--port', url.port];
        }
        assertActive(signal);
        await fs.mkdir(this.options.storagePath, { recursive: true });
        assertActive(signal);
        const nodeDirectory = path.dirname(node);
        const env = { ...process.env, HOST: '127.0.0.1', SQLITE_PATH: path.join(this.options.storagePath, 'db.sqlite'),
          OUTBOUND_URL_ALLOWED_HOSTS: JSON.stringify(['127.0.0.1', 'localhost', '::1']),
          PATH: [nodeDirectory, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(path.delimiter),
          npm_config_cache: path.join(this.options.storagePath, 'npm-cache'),
        };
        this.log(`Starting local TrueForge 0.183.1 at ${url.origin}${args[0] !== cli ? ' (first startup may download the pinned runtime)' : ''}.`);
        child = spawn(node, args, { cwd: this.options.storagePath, env, shell: false, windowsHide: true,
          detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        this.child = child;
        const launched = child;
        const capture = (data: Buffer) => { const line = redact(data.toString('utf8')); output = (output + line).slice(-4_000); this.log(line); };
        child.stdout?.on('data', capture); child.stderr?.on('data', capture);
        child.once('error', error => { failure = error; });
        child.once('exit', (code, exitSignal) => {
          if (this.child === launched) this.child = undefined;
          failure = new Error(`TrueForge exited ${exitSignal ? `with ${exitSignal}` : `with code ${code}`}.`);
        });
      }
      const owned = child;
      const stop = () => this.stop(owned);
      signal.addEventListener('abort', stop, { once: true });
      try {
        const deadline = Date.now() + 60_000;
        for (;;) {
          assertActive(signal);
          if (await online(url, signal)) { this.log(`Local TrueForge is ready at ${url.origin}.`); return; }
          if (failure || owned.exitCode !== null || owned.signalCode !== null) throw failure ?? new Error('The local TrueForge process exited before it became ready.');
          if (Date.now() >= deadline) throw new Error('TrueForge did not become ready within 60 seconds. Its first installation may need more time.');
          await delay(250, signal);
        }
      } finally { signal.removeEventListener('abort', stop); }
    } catch (error) {
      if (child) this.stop(child);
      if (signal.aborted) throw cancelled();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail}${output.trim() ? `\n${output.trim()}` : ''}\nYou can start TrueForge manually: ${MANUAL_START}`);
    }
  }

  private stop(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid!, signal); // The detached group belongs solely to this launch, including npx descendants.
      } catch { /* It may have exited between the check and signal. */ }
    };
    kill('SIGTERM');
    const timer = setTimeout(() => {
      this.shutdownTimers.delete(timer);
      if (child.exitCode === null && child.signalCode === null) kill('SIGKILL');
    }, 2_000);
    timer.unref(); this.shutdownTimers.add(timer);
    child.once('exit', () => { clearTimeout(timer); this.shutdownTimers.delete(timer); });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.startup?.controller.abort();
    if (this.child) this.stop(this.child);
  }
}
