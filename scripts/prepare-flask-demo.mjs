import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = path.join(root, 'submission/workspaces/flask-3.1.3');
const expectedCommit = '22d924701a6ae2e4cd01e9a15bbaf3946094af65';
const python = process.env.TRUEFORAGE_FLASK_PYTHON || 'python3';

function run(executable, args, cwd = root, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: environment, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${executable} ${args.join(' ')} exited with ${code}.`)));
  });
}

async function exists(target) { try { await access(target); return true; } catch { return false; } }
async function output(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    let text = '';
    const child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', chunk => { text += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(text.trim()) : reject(new Error(`${executable} ${args.join(' ')} exited with ${code}.`)));
  });
}

async function dependenciesAreReady(interpreter) {
  try {
    await output(interpreter, ['-c', [
      'from importlib.metadata import version',
      'assert version("flask") == "3.1.3"',
      'assert version("pytest") == "8.4.2"',
      'assert version("click") == "8.2.1"',
      'import flask, pytest, click',
    ].join('; ')], workspace);
    return true;
  } catch {
    return false;
  }
}

await mkdir(path.dirname(workspace), { recursive: true });
if (!await exists(path.join(workspace, '.git'))) {
  await run('git', ['clone', '--filter=blob:none', '--branch', '3.1.3', 'https://github.com/pallets/flask.git', workspace]);
}
const commit = await output('git', ['rev-parse', 'HEAD'], workspace);
if (commit !== expectedCommit) throw new Error(`Expected Flask ${expectedCommit}, found ${commit}. Remove only this prepared workspace and rerun.`);
const venv = path.join(workspace, '.venv');
const interpreter = process.platform === 'win32' ? path.join(venv, 'Scripts/python.exe') : path.join(venv, 'bin/python');
if (!await exists(interpreter)) await run(python, ['-m', 'venv', venv]);
const dependenciesReady = await dependenciesAreReady(interpreter);
if (!dependenciesReady) {
  await run(interpreter, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  await run(interpreter, ['-m', 'pip', 'install', '-e', '.[async,dotenv]', 'pytest==8.4.2', 'click==8.2.1'], workspace);
}
const localExclude = path.join(workspace, '.git/info/exclude');
const ignoredLocalState = ['.venv/', '.vscode/', '.trueforge/'];
const excludeText = await readFile(localExclude, 'utf8');
const missingExclusions = ignoredLocalState.filter(item => !excludeText.split(/\r?\n/).includes(item));
if (missingExclusions.length) await appendFile(localExclude, `\n# TrueForage local Flask demo state\n${missingExclusions.join('\n')}\n`);
const version = await output(interpreter, ['-c', 'from importlib.metadata import version; print(version("flask"))'], workspace);
await readFile(path.join(workspace, 'src/flask/helpers.py'), 'utf8');
console.log(JSON.stringify({ status: 'ready', workspace, commit, flaskVersion: version, interpreter, dependenciesReused: dependenciesReady, taskRunbook: path.join(root, 'submission/FLASK_TASKS.md') }, null, 2));
