# Forge-a-thon Flask tasks

This runbook prepares the exact Flask 3.1.3 checkout and recording steps from the supplied brief. It does not replace the requested live-agent work: use a genuine model configured in local TrueForge when recording Tasks A, B, and C.

## Prepare once

From the extension project:

```sh
npm run prepare:flask-demo
```

This creates the ignored workspace at `submission/workspaces/flask-3.1.3`, verifies commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`, creates `.venv`, and installs Flask with the required async, dotenv, pytest, and Click dependencies. It does not change Flask source files. The local Git exclude file ignores the virtual environment and local VS Code / TrueForge state, so Task C's `git status --short` only reports source changes.

Use a fresh copy of this prepared workspace for each recording task. The model should be selected through **TrueForage: Choose Model**, with all model calls routed through local TrueForge.

To launch the prepared checkout in a VS Code Extension Development Host, run:

```sh
npm run open:flask-demo
```

In that window, open the TrueForage view, choose the configured TrueForge model, and run the task from the mode named below.

## A — Inline edit and undo

Open `src/flask/helpers.py`, select the full `get_debug_flag` function, then use **Cmd+Alt+I** (macOS) or **Ctrl+Alt+I** and send this prompt verbatim:

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

In **Review** mode, show the native diff, accept the intended hunk, apply it, and save. Run this exact command from the Flask workspace:

```sh
FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
```

Record `False`, then show **Undo task** or native undo restoring the original function.

## B — Filename-free multi-file Agent task

Start a new **Agent** session. Do not attach or name any file. Send this prompt verbatim:

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

Keep the Change Map open. Record why the agent selected the implementation, test, and documentation files; inspect the hunks; then apply and save the accepted changes. After the agent has made the change, run:

```sh
npm run verify:flask-demo
```

The verifier runs `pytest tests/test_cli.py -q`, confirms `config` appears in `flask --help`, and runs `flask --app demo_app config` with the harmless fixture in `submission/flask-demo/demo_app.py`. It expects `API_TOKEN` to be `"***"` and `PUBLIC_VALUE` to remain visible. The verifier deliberately fails before Task B has been implemented.

## C — Resilience and cancellation

Start from a clean copy at the same commit. In local TrueForge configure an unreachable primary provider or invalid provider key, and configure a known working fallback model if one is available. Repeat the Task A prompt.

Record the visible retry, error, or fallback selection. Do not apply a fallback proposal. Record:

```sh
git status --short
```

It must be empty. Start one further task, press **Stop task** while it streams, and show that no unapplied hunk changed the workspace.

## What to record, in order

1. Task A: selection, exact prompt, native diff, apply, `False`, undo.
2. Task B: exact prompt, Change Map, three-file hunk review, TrueForge session/tools, test, help, masked JSON.
3. Task C: clean checkout, provider failure/retry or fallback, clean Git status, cancellation.

Keep the final continuous video under four minutes. The local narrated project walkthrough is supporting material only; it is not a substitute for this required A/B/C recording.
