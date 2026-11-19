# Demo plan

Current milestone: a monochrome coding workbench with actual Agent edit/save/test/fix/retest, Review and Ask modes, task undo, and optional local playground fixtures. Use Review mode for the competition recording. Inspect the conversation, file changes, native diffs and command results. The playground is not a recording of competition Tasks A, B or C.

## Playground walkthrough

Run **TrueForage: Try Review Playground** in the Extension Development Host. Watch the streamed fixture explanation, inspect the three context choices, review four hunks, reject the documentation change, accept the implementation and tests, then apply. Show one native undo restoring both changed files. Restart and cancel while text streams.

## Competition recording to produce later

Use a clean separate Flask 3.1.3 checkout, exact commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`, and the verbatim A/B/C prompts from the supplied brief. Record real model activity continuously. Keep the public video under four minutes.

1. A: Select `get_debug_flag`, instruct the model, review and apply. Verify `FLASK_DEBUG=off` prints `False`; demonstrate native undo.
2. B: Send the filename-free CLI instruction. Keep file changes and context visible; review implementation, tests and documentation. Verify CLI tests, help output and masked JSON. Inspect this run's actual TrueForge session, turns and approval.
3. C: Use a clean checkout and broken primary provider. Show retry/error or configured fallback, leave fallback changes unapplied, show clean git status, and demonstrate live cancellation.

Before submission: verified team details, genuine model names/location/cost, public GitHub URL, public video URL and public 1–3 page PDF. The PDF uses the brief's eight required headings in order. Add accurate recording timestamps to the scorecard only after recording. Do not copy fixture outcomes into genuine-model evidence.
