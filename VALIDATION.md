# Validation — 18 November 2026, version 0.3.0

This is an original implementation. Evidence quoted for a previous package in the supplied brief does not describe this project.

## Observed

- TypeScript check and bundled extension build pass.
- Node suite: **59 tests passed**, zero failures. Includes retrieval and revision safety, SDK transport, mode-specific policies, real HTTP MCP auth and cancellation, actual command processes, process-group timeout/cancellation and runtime startup/recovery.
- Graphical native host: **15 scenarios passed** in VS Code 1.140.0 on macOS. Includes original Review/native-diff/selection/undo/stale checks and real Agent batches, persistence, failing-test feedback, correction, passing rerun, saved aggregate undo, Ask tool rejection, save-participant formatting, and invalidating a pass after later edits.
- Actual pinned TrueForge runtime integration: **22 deterministic provider requests** exercised Review approval/resume, session continuation and Agent inspect/plan/apply/test/fix/retest. The test command really failed with exit 1, its output returned to the agent loop, and the corrected run really passed with exit 0. Agent made no generic review-approval request.
- Browser workbench: checked at 320 px and 1120 px. Monochrome layout, plans, activity and command cards, mode selection, attachments, history, editor expansion, copy, review/apply/undo, retry/test actions, persisted draft acknowledgments and safe rendering were verified. Sample data remains labelled.
- Genuine Gemini coding smoke: **passed** through TrueForge in the native editor. The model discovered an isolated Node project, ran the original tests (exit 1), saved a clamp fix, reran them (exit 0), and returned an accurate final response. An independent process also passed all three original tests; the assertions stayed byte-identical.

Machine-readable native fixture evidence: `artifacts/host-results.json`. Those 15 scenarios and the 22-request harness integration use deterministic model providers. TrueForge, HTTP/MCP, VS Code edits and command execution are actual implementations. The separate genuine-model smoke is recorded in `artifacts/real-model-smoke.json` and pictured in `artifacts/real-model-agent.png`.

## Live model status

The configured model **`google-gemini/gemini-3-1-flash-lite`** now answers through TrueForge. The successful connection check returned "TrueForage connected." The subsequent successful coding run used session `01m7qwrrn3yyr494522zp5qbmb`, changed `app.cjs`, and ran `node --test app.test.cjs` before and after its fix. Its final response and independently verified output are preserved in the smoke artifact. This establishes one small real edit/test task, not large-repository or Flask performance.

Earlier connection attempts returned HTTP 400/403. An earlier coding attempt timed out when macOS entered idle sleep just after its tests passed. An awake attempt exposed malformed model command arguments; essential Agent schemas are now preloaded and command guidance and approval-error feedback include the required split executable/argv format. The final bounded awake run passed. No credentials were included in saved diagnostics.

Local open-source TrueForge requires no cloud account or work email. Any supported provider configured there follows the model-routing architecture. TrueFoundry AI Gateway remains optional.

## Still open

- Genuine external-model runs for the exact Flask A/B/C prompts and outputs.
- Live invalid-provider fallback in the editor, beyond transport/fixture validation.
- Prepared Flask verification environment and recorded results.
- Public repository, four-minute recording, team/model/cost declarations and public PDF.

## Practical limits

The configured model determines planning and coding quality. Automatic retrieval is bounded and lexical rather than a full language-server index. Active language extensions determine diagnostics. Normal commands run repository code with user permissions; this is not an OS sandbox. Unknown commands need exact approval; recognized Agent validation commands run automatically. Review tests use a temporary copy and may need an external prepared interpreter because dependency directories are excluded. Command output is capped at 1 MB and timeout at 120 seconds. History restores text, not file changes. Explicit Undo task checks expected current contents and refuses later conflicting edits.

The competition's native hunk-review demonstrations should use Review mode. Agent mode is the normal apply/save/test workflow; Ask is read-only. Inline selection edits use Review.
