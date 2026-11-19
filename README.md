# TrueForage

A VS Code coding workspace built on **TrueForge**, with Agent, Review and Ask modes. The agent can inspect the repository, edit and save code, execute tests, use failures to revise its changes, and verify the result. Plans, file changes and streamed command output stay visible in a monochrome interface.

## Run in VS Code

Requires VS Code **1.104+**, external Node.js **22.14+**, and npm.

1. **Extensions → … → Install from VSIX…** → select `trueforage-0.3.0.vsix`.
2. Reload VS Code and open the repository you want the assistant to work on.
3. Run **TrueForage: Connect Model**. Choose **Configure a model in local TrueForge**, then add a provider under local **Settings → Models**.
4. Run **TrueForage: Choose Model**. The extension verifies that the selected model can answer before marking it connected.
5. Run **TrueForage: Open Coding Workspace** for the wide editor view, or **TrueForage: Open Chat** for the sidebar. Choose **Agent** and describe the change, including the tests you want run.

**A TrueFoundry cloud account or work email is not required.** Local open-source TrueForge supports catalog providers and compatible endpoints. A provider API key or local model endpoint is still required for genuine inference. All model calls and tool routing remain in TrueForge.

For source development:

```sh
cd trueforage
npm ci
npm run build
npm run assistant
```

`npm run assistant -- /absolute/path/to/your/repository` opens a different target repository. F5 launches an Extension Development Host on the current repository. `npm run playground` explicitly opens the separate scripted review sample; it does not silently replace real prompts.

## Work modes

| Mode | Edits | Commands |
| --- | --- | --- |
| **Agent** | Applies and saves requested workspace changes; can revise later batches after test feedback. | Recognized tests, builds, type checks, lint and read-only Git commands run automatically. Other exact commands require approval. |
| **Review** | Stages hunks until you accept/reject them, then applies the accepted subset. | Exact-command approval, execution in a temporary copy with staged changes. |
| **Ask** | Read-only exploration and explanation. | Arbitrary command and mutation tools are excluded and rejected. |

The inline shortcut **Cmd+Alt+I / Ctrl+Alt+I** uses Review and constrains changes to the selected range. Use Review for the competition's hunk-review demonstrations. Agent mode follows the user's instruction through editing and verification without stopping at a proposal.

Examples:

> Fix the configuration parser and add regression tests. Run the relevant tests, correct any failures caused by your changes, and report what passed.

> Investigate this repository and explain where authentication is implemented. Do not change files.

The **Run tests** action sends an actual test task to the configured agent. It does not manufacture a result or invoke a hardcoded sample. The agent discovers the project's commands and environment through workspace tools.

## Review, undo and verification

Plans, repository activity, source evidence, changed files and command output are available beside the conversation. Use the attachment picker or `@file(path)` / `@symbol(name)`. Open file paths or native diffs directly. Local conversation history restores chat text and starts fresh backend context when resumed; it does not restore or replay edits.

Agent edits use VS Code WorkspaceEdit and are saved. **Undo task** restores the initial file contents across all batches in that task, including save-participant formatting, and saves restored files. It refuses stale text if files changed after the recorded task. Review applies accepted hunks in one editor transaction; native **Cmd+Z / Ctrl+Z** remains available. Save reviewed editor buffers to persist them.

Commands show their actual executable, arguments, working directory, streamed stdout/stderr, exit status and duration. They run with `shell:false`, a 120-second cap and a shared 1 MB output limit. Cancellation stops the owned process group; another task waits for cleanup. Command approval includes the normalized cwd, timeout and mode as well as executable and argv.

A passing result belongs to the revision it tested. A later applied edit marks earlier results stale, so the interface does not call the final code verified until relevant commands pass again. The agent reads real failure output and can revise unapplied hunks or make a new saved batch before rerunning.

Agent commands run in the actual workspace so installed dependencies are available. Review uses a temporary copy that excludes dependencies and private files; use an absolute prepared interpreter where needed. Neither execution path is an operating system sandbox. Repository code runs with your user permissions.

## Local runtime and model setup

The extension starts the pinned local runtime when needed, reuses an existing loopback server and exposes authenticated editor MCP tools. Development uses the installed package; an installed VSIX can launch `npx @truefoundry/trueforge@0.183.1`. Set `trueforage.nodePath` if Node is not found.

Manual startup:

```sh
npm run trueforge
```

The usual address is `http://127.0.0.1:8790`. Model credentials are managed in local TrueForge. The manual launcher uses ignored `.trueforge/db.sqlite`; extension-managed startup uses the VS Code profile's extension storage. Keep using the same running instance when editing provider settings.

A configured model name does not prove usable credentials. Google 403 errors require checking the key's project permissions, enabled Generative Language API, restrictions or project verification. Google AI Studio keys are available at https://aistudio.google.com/apikey. Keep keys out of chat and source files.

**Optional TrueFoundry AI Gateway:** choose it in Connect Model and enter the exact Gateway Base URL, Model ID and masked access token from its Playground Code Snippet. The token is kept in VS Code SecretStorage for reuse and passed to local TrueForge provider configuration. It is not sent to the webview or settings JSON. The wizard performs a small real model request to verify access; provider billing applies. No guessed API path suffixes are added.

## Validation and preview

```sh
npm run check
npm test
npm run build
npm run test:host
npm run test:trueforge
npm run package
```

`test:host` uses an isolated graphical VS Code profile. It verifies actual editor changes, persistence, native diffs, selection bounds, task undo, cancellation, mode boundaries, a real test failure followed by correction and success, save participants, and stale verification after later edits. The model provider is deterministic; the local TrueForge runtime, editor operations and test processes are real.

`npm run test:live` optionally runs one real configured model against an isolated clamp-function bug and its original Node tests. It uses the provider configured in local TrueForge and can consume provider quota. It requires a working local server.

The observed Gemini smoke passed: it discovered the files, ran failing tests, saved its correction, reran all three unchanged tests successfully and returned the actual result. This is a small live workflow check; the exact Flask competition tasks remain open. See `artifacts/real-model-smoke.json` and `VALIDATION.md` for evidence.

`test:trueforge` exercises the pinned harness with a deterministic gateway, including Agent iteration and Review approvals. It makes no external or paid model request. Observed evidence and open work are recorded in `VALIDATION.md`.

`npm run preview` serves the browser workbench fixture at `http://127.0.0.1:4319`. Its sample output is explicitly labelled. It does not prove real model intelligence or change a repository.

## Architecture

```text
VS Code workspace → official SDK → local TrueForge → selected model provider
                                      ↕
                     authenticated workspace MCP tools
                                      ↕
              inspect → plan → edit/apply → test → correct → verify
                                      ↕
                        native diffs and task undo
```

The eleven MCP tools are `list_files`, `search_context`, `read_file`, `propose_edit`, `revise_edit`, `apply_changes`, `review_changes`, `run_command`, `update_plan`, `get_diagnostics`, and `workspace_status`. Ask exposes only the five read tools. The agent definition lives in `src/agent.json` and its mode-specific contract is applied by the harness adapter.

Context retrieval uses overlapping 60-line excerpts, lexical/path/definition ranking, and a 24,000-byte UTF-8 evidence budget. Discovery is capped at 2,000 paths; automatic scanning at 240 files / 8 MB. Explicit file references take priority. Paths escaping the workspace, private configuration and binary/large files are excluded.

Starting point: **from scratch**. Original code is MIT licensed; bundled dependency licences are in `THIRD_PARTY_NOTICES.md`. Development used OpenAI Codex with collaborating coding agents. TrueForge is pinned at 0.183.1 with SDK 0.183.0; see `docs/trueforge.md` before updating their approval lifecycle.

Genuine model runs for the exact Flask A/B/C tasks, public repository/video/PDF, verified team details and the recording scorecard remain to be produced. The supplied brief's previous-package results are not claimed for this implementation.

Primary references: [TrueForge](https://github.com/truefoundry/trueforge), [provider setup](https://github.com/truefoundry/trueforge/blob/main/docs/quickstart.mdx), [competition](https://techfest.org/competitions/forge-a-thon).
