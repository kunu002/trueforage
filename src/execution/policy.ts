import * as path from 'node:path';

export type ExecutionMode = 'agent' | 'review' | 'ask';
export interface CommandClassificationInput { executable: string; args: readonly string[]; mode: ExecutionMode }
export interface CommandClassification { automatic: boolean; reason: string }

const validationScripts = new Set([
  'test', 'test:unit', 'test:integration', 'test:e2e', 'test:ci', 'test:coverage',
  'check', 'check:types', 'build', 'lint', 'lint:check', 'format:check', 'typecheck', 'type-check',
]);
const readOnlyGit = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files']);

function decision(automatic: boolean, reason: string): CommandClassification { return { automatic, reason }; }
function known(reason: string): CommandClassification {
  return decision(true, `${reason} Repository validation can execute repository code with your user permissions.`);
}

/** Classifies an argv array. This is an approval policy, not an operating system sandbox. */
export function classifyCommand(input: CommandClassificationInput): CommandClassification {
  if (input.mode === 'ask') return decision(false, 'Ask mode does not execute commands.');
  if (input.mode === 'review') return decision(false, 'Review mode requires approval of this exact executable and argument array.');
  if (input.mode !== 'agent') return decision(false, 'Unknown execution mode.');
  if (typeof input.executable !== 'string' || !input.executable || !Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string')) {
    return decision(false, 'A command requires an executable and a string argument array.');
  }
  const args = input.args;
  if ([input.executable, ...args].some(value => /[\0\r\n]/.test(value)) || args.some(arg => /(?:[;&|<>`]|\$\()/.test(arg))) {
    return decision(false, 'Shell syntax or control characters require exact user review; commands run without a shell.');
  }
  const executable = path.basename(input.executable.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh', 'curl', 'wget', 'ssh', 'scp', 'rm', 'rmdir', 'del', 'sudo', 'npx', 'uv', 'pip', 'pip3'].includes(executable)) {
    return decision(false, 'Shells, installers, network tools and destructive commands require explicit user approval.');
  }
  if (args.some(arg => /^(?:--(?:script-shell|node-options|userconfig|globalconfig|prefix|registry|config|exec-path|git-dir|work-tree|output|output-file|out-file|basetemp))(?:=|$)/.test(arg))) {
    return decision(false, 'This command changes execution configuration, scope or an output destination and requires approval.');
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    const operation = args[0];
    const script = operation === 'run' ? args[1] : operation;
    const allowed = script && validationScripts.has(script) && (operation === 'run' || operation === 'test' || executable !== 'npm');
    if (!allowed) return decision(false, 'Only recognized test, build, check and lint scripts run automatically; package installation and publishing require approval.');
    if (args.some(arg => /^(?:--(?:eval|print|preload|require|loader|import)|-[er])(?:=|$)/.test(arg))) return decision(false, 'Injected code or preload options require explicit approval.');
    return known(`Recognized ${executable} validation script: ${script}.`);
  }
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) {
    const firstModule = args.indexOf('-m');
    if (firstModule < 0 || !args.slice(0, firstModule).every(arg => ['-B', '-u', '-I', '-E', '-s'].includes(arg))) {
      return decision(false, 'Automatic Python execution is limited to -m pytest, unittest or compileall.');
    }
    const module = args[firstModule + 1];
    if (!['pytest', 'unittest', 'compileall'].includes(module ?? '')) return decision(false, 'This Python module requires explicit user approval.');
    return known(`Recognized Python validation module: ${module}.`);
  }
  if (executable === 'pytest') return known('Recognized pytest validation.');
  if (executable === 'node') {
    if (!args.includes('--test') || args.some(arg => /^(?:--(?:eval|print|import|require|loader|experimental-loader|input-type)|-[epr])(?:=|$)/.test(arg))) {
      return decision(false, 'Automatic Node.js execution requires --test and excludes injected code and module loaders.');
    }
    return known('Recognized Node.js test runner.');
  }
  if (executable === 'tsc') {
    if (args.includes('--init')) return decision(false, 'Creating a TypeScript configuration requires approval.');
    return known('Recognized TypeScript check/build.');
  }
  if (executable === 'eslint') {
    if (args.some(arg => arg === '--fix' || arg.startsWith('--fix='))) return decision(false, 'ESLint automatic fixes modify source and require approval.');
    return known('Recognized ESLint validation.');
  }
  if (executable === 'cargo') {
    if (['test', 'check', 'clippy', 'build'].includes(args[0] ?? '') || (args[0] === 'fmt' && args.includes('--check'))) return known('Recognized Cargo validation.');
    return decision(false, 'This Cargo operation requires explicit user approval.');
  }
  if (executable === 'go') {
    if (['test', 'vet', 'build'].includes(args[0] ?? '')) return known('Recognized Go validation.');
    return decision(false, 'This Go operation requires explicit user approval.');
  }
  if (executable === 'dotnet') {
    if (['test', 'build'].includes(args[0] ?? '') || (args[0] === 'format' && args.includes('--verify-no-changes'))) return known('Recognized .NET validation.');
    return decision(false, 'This .NET operation requires explicit user approval.');
  }
  if (executable === 'git') {
    const commandArgs = [...args];
    while (['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs'].includes(commandArgs[0] ?? '')) commandArgs.shift();
    if (!readOnlyGit.has(commandArgs[0] ?? '')) return decision(false, 'Only git status, diff, log, show, rev-parse and ls-files run automatically.');
    if (commandArgs.some(arg => /^(?:--(?:ext-diff|textconv|no-index|paginate))(?:=|$)/.test(arg))) {
      return decision(false, 'External diff/text conversion or expanded Git scope requires approval.');
    }
    return decision(true, `Recognized read-only git ${commandArgs[0]}; no external diff or text-conversion command was requested.`);
  }
  return decision(false, 'This executable or operation needs approval of the exact command.');
}
