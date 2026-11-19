import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = process.env.TRUEFORAGE_FLASK_WORKSPACE || path.join(root, 'submission/workspaces/flask-3.1.3');
const expectedCommit = '22d924701a6ae2e4cd01e9a15bbaf3946094af65';
const interpreter = process.platform === 'win32' ? path.join(workspace, '.venv/Scripts/python.exe') : path.join(workspace, '.venv/bin/python');
const fixtureDirectory = path.join(root, 'submission/flask-demo');

function run(executable, args, options = {}) {
  return new Promise(resolve => {
    let stdout = ''; let stderr = '';
    const child = spawn(executable, args, { cwd: workspace, shell: false, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => resolve({ code: -1, stdout, stderr: error.message }));
    child.once('exit', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

try { await access(interpreter); } catch { throw new Error(`Flask demo environment is missing. Run npm run prepare:flask-demo first: ${interpreter}`); }
const commit = await run('git', ['rev-parse', 'HEAD']);
if (commit.code !== 0 || commit.stdout.trim() !== expectedCommit) throw new Error(`The Flask workspace is not the required commit ${expectedCommit}.`);
const pythonPath = [fixtureDirectory, workspace, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
const tests = await run(interpreter, ['-m', 'pytest', 'tests/test_cli.py', '-q']);
const help = await run(interpreter, ['-m', 'flask', '--app', 'demo_app', '--help'], { env: { PYTHONPATH: pythonPath } });
const config = await run(interpreter, ['-m', 'flask', '--app', 'demo_app', 'config'], { env: { PYTHONPATH: pythonPath } });
const passed = tests.code === 0 && help.code === 0 && config.code === 0 && /\bconfig\b/.test(help.stdout) && /"API_TOKEN"\s*:\s*"\*\*\*"/.test(config.stdout) && /"PUBLIC_VALUE"\s*:\s*"visible-demo-setting"/.test(config.stdout);
const report = { workspace, commit: commit.stdout.trim(), tests, help, config, passed };
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
