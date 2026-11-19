import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ChangeSet, normalizeWorkspacePath, parseContextDirectives, renderContext, retrieveContext } from '../src/core';

test('revising a staged hunk retains its original snapshot and resets the review decision', () => {
  const changes = new ChangeSet();
  const first = changes.stage({ path: 'value.js', start: 4, end: 5, original: '1', replacement: '3' }, 'x = 1;');
  changes.review(first.id, 'accepted');
  const revised = changes.revise(first.id, '2', 'x = 1;', 'Correct the failing assertion.');
  assert.equal(revised.id, first.id); assert.equal(revised.status, 'pending'); assert.equal(revised.original, '1');
  changes.review(revised.id, 'accepted');
  assert.equal(changes.acceptedOutputs(new Map([['value.js', 'x = 1;']]))[0].content, 'x = 2;');
});

test('revising refuses stale source and overlap with a replacement proposal', () => {
  const changes = new ChangeSet();
  const first = changes.stage({ path: 'value.js', start: 0, end: 3, original: 'abc', replacement: 'xyz' }, 'abcdef');
  assert.throws(() => changes.revise(first.id, 'new', 'abc changed'), /Stale/);
  changes.review(first.id, 'rejected');
  changes.stage({ path: 'value.js', start: 1, end: 4, original: 'bcd', replacement: '123' }, 'abcdef');
  assert.throws(() => changes.revise(first.id, 'new', 'abcdef'), /overlaps/);
});

test('accepted subset is composed from the original without changing rejected hunks', () => {
  const changes = new ChangeSet();
  const original = 'hello brave world';
  const first = changes.stage({ path: 'src/main.ts', start: 0, end: 5, original: 'hello', replacement: 'goodbye' }, original);
  const second = changes.stage({ path: 'src/main.ts', start: 6, end: 11, original: 'brave', replacement: 'small' }, original);
  changes.review(first.id, 'accepted');
  changes.review(second.id, 'rejected');
  const result = changes.acceptedOutputs(new Map([['src/main.ts', original]]));
  assert.deepEqual(result, [{ path: 'src/main.ts', original, content: 'goodbye brave world', editIds: [first.id] }]);
});

test('apply validates all original snapshots, including changes outside proposed ranges', () => {
  const changes = new ChangeSet();
  const edit = changes.stage({ path: 'a.py', start: 0, end: 1, original: 'a', replacement: 'b' }, 'a tail');
  changes.review(edit.id, 'accepted');
  assert.throws(() => changes.acceptedOutputs(new Map([['a.py', 'a changed tail']])), /Stale proposal/);
  assert.throws(() => changes.stage({ path: 'a.py', start: 0, end: 1, original: 'a', replacement: 'z' }, 'a changed tail'), /Stale edit/);
});

test('overlapping edits and insertions cannot silently overwrite another proposal', () => {
  const changes = new ChangeSet();
  const first = changes.stage({ path: 'a.ts', start: 1, end: 4, original: 'bcd', replacement: 'X' }, 'abcdef');
  assert.throws(() => changes.stage({ path: 'a.ts', start: 2, end: 5, original: 'cde', replacement: 'Y' }, 'abcdef'), /Overlapping/);
  assert.throws(() => changes.stage({ path: 'a.ts', start: 2, end: 2, original: '', replacement: 'Y' }, 'abcdef'), /Overlapping/);
  changes.review(first.id, 'rejected');
  changes.stage({ path: 'a.ts', start: 2, end: 5, original: 'cde', replacement: 'Y' }, 'abcdef');
  assert.throws(() => changes.review(first.id, 'accepted'), /overlaps/);
});

test('adjacent ranges and boundary insertions compose deterministically', () => {
  const changes = new ChangeSet();
  for (const input of [
    { start: 0, end: 0, original: '', replacement: '(' },
    { start: 0, end: 1, original: 'a', replacement: 'A' },
    { start: 1, end: 2, original: 'b', replacement: 'B' },
    { start: 2, end: 2, original: '', replacement: ')' },
  ]) changes.review(changes.stage({ path: 'a.ts', ...input }, 'ab').id, 'accepted');
  assert.equal(changes.acceptedOutputs(new Map([['a.ts', 'ab']]))[0]!.content, '(AB)');
});

test('inline edits cannot escape selection or use invalid offsets or stale source', () => {
  const changes = new ChangeSet();
  const proposal = { path: 'a.py', start: 1, end: 3, original: 'bc', replacement: 'xx' };
  assert.throws(() => changes.stage(proposal, 'abcde', { selection: { start: 2, end: 4 } }), /escapes/);
  assert.throws(() => changes.stage({ ...proposal, start: -1 }, 'abcde'), /Invalid edit/);
  assert.throws(() => changes.stage({ ...proposal, original: 'xx' }, 'abcde'), /Stale edit/);
  const edit = changes.stage(proposal, 'abcde', { selection: { start: 1, end: 3 } });
  changes.review(edit.id, 'accepted');
  assert.equal(changes.acceptedOutputs(new Map([['a.py', 'abcde']]))[0]!.content, 'axxde');
});

test('cancellation discards accepted and pending unapplied changes', () => {
  const changes = new ChangeSet();
  const edit = changes.stage({ path: 'a.py', start: 0, end: 1, original: 'a', replacement: 'b' }, 'a');
  changes.review(edit.id, 'accepted');
  changes.discardPending();
  assert.deepEqual(changes.list(), []);
  assert.deepEqual(changes.acceptedOutputs(new Map([['a.py', 'a']])), []);
});

test('callers cannot mutate staged state through returned objects', () => {
  const changes = new ChangeSet();
  const edit = changes.stage({ path: 'a.py', start: 0, end: 1, original: 'a', replacement: 'b' }, 'a');
  edit.status = 'accepted';
  changes.list()[0]!.replacement = 'c';
  assert.equal(changes.list()[0]!.status, 'pending');
  assert.equal(changes.list()[0]!.replacement, 'b');
});

test('workspace path parser refuses absolute paths, traversal, ambiguous separators and NULs', () => {
  assert.equal(normalizeWorkspacePath('./src\\main.ts'), 'src/main.ts');
  for (const path of ['/etc/passwd', '../secret', 'src/../../secret', 'C:\\secret', 'a//b', 'a/./b', 'a\0b']) {
    assert.throws(() => normalizeWorkspacePath(path), /workspace path|Workspace paths/);
  }
});

test('directives parse quoted file paths and deduplicate symbols', () => {
  assert.deepEqual(parseContextDirectives('Read @file("src/my file.ts") and @symbol(get_debug_flag), @symbol(get_debug_flag).'), {
    files: ['src/my file.ts'], symbols: ['get_debug_flag'],
  });
  assert.throws(() => parseContextDirectives('@file(../../secret)'), /Workspace paths/);
});

test('automatic retrieval gives tests and documentation visible evidence with reasons', () => {
  const result = retrieveContext([
    { path: 'src/flask/cli.py', content: 'def config_command():\n    """Print application config as JSON."""\n    pass' },
    { path: 'tests/test_cli.py', content: 'def test_config_command():\n    assert runner.invoke(["config"]).exit_code == 0' },
    { path: 'docs/cli.rst', content: 'Built-in commands\nA config command prints configuration as JSON.' },
    { path: 'src/unrelated.py', content: 'def square(x):\n    return x*x' },
  ], 'Add a CLI config command with a test and documentation and print JSON.');
  assert.equal(result.entries.length, 3);
  assert.equal(result.entries.some((entry) => entry.path === 'src/unrelated.py'), false);
  assert.equal(result.entries.find((entry) => entry.path === 'src/flask/cli.py')!.reason.includes('definitions'), true);
  assert.equal(result.usedBytes, Buffer.byteLength(renderContext(result), 'utf8'));
});

test('explicit file and symbol references prioritize matching source excerpts', () => {
  const result = retrieveContext([
    { path: 'src/a.py', content: 'def unrelated():\n    return 1' },
    { path: 'src/b.py', content: 'def get_debug_flag():\n    return False' },
  ], '@file(src/a.py) @symbol(get_debug_flag)');
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]!.path, 'src/a.py');
  assert.match(result.entries[0]!.reason, /explicit @file/);
  assert.match(result.entries[1]!.reason, /@symbol get_debug_flag/);
});

test('retrieval strictly budgets UTF-8 rendered evidence without splitting emoji', () => {
  const result = retrieveContext([{ path: 'unicode.txt', content: 'needle ' + '🌱'.repeat(2000) }], 'needle', { budgetBytes: 221 });
  assert.ok(result.entries[0]!.truncated);
  assert.ok(result.usedBytes <= 221);
  assert.equal(result.usedBytes, Buffer.byteLength(renderContext(result), 'utf8'));
  assert.equal(result.entries[0]!.content.includes('\uFFFD'), false);
  assert.ok(result.entries[0]!.content.endsWith('🌱'));
});

test('retrieval clamps to 24000 bytes and never emits overlapping excerpts from one file', () => {
  const content = Array.from({ length: 400 }, (_, index) => `needle ${index}: ${'x'.repeat(100)}`).join('\n');
  const result = retrieveContext([{ path: 'a.txt', content }], 'needle', { budgetBytes: 90_000 });
  assert.equal(result.budgetBytes, 24_000);
  assert.ok(result.usedBytes <= 24_000);
  assert.equal(result.usedBytes, Buffer.byteLength(renderContext(result), 'utf8'));
  for (let index = 0; index < result.entries.length; index++) {
    for (let other = index + 1; other < result.entries.length; other++) {
      const first = result.entries[index]!;
      const second = result.entries[other]!;
      assert.ok(first.endLine < second.startLine || second.endLine < first.startLine);
    }
  }
});

test('empty, unmatched and zero-budget searches provide empty evidence', () => {
  assert.equal(retrieveContext([], 'needle').usedBytes, 0);
  assert.equal(retrieveContext([{ path: 'a', content: 'nothing here' }], 'missing').entries.length, 0);
  assert.equal(retrieveContext([{ path: 'a', content: 'needle' }], 'needle', { budgetBytes: 0 }).entries.length, 0);
});

test('non-finite context options cannot bypass the UTF-8 budget', () => {
  for (const budgetBytes of [NaN, Infinity, -Infinity]) {
    assert.throws(() => retrieveContext([{ path: 'a', content: 'needle' }], 'needle', { budgetBytes }), /must be finite/);
  }
});

test('symbol retrieval handles dollar-suffixed TypeScript identifiers without partial matches', () => {
  const result = retrieveContext([
    { path: 'a.ts', content: 'const observe$ = () => 1;' },
    { path: 'b.ts', content: 'const observe$extra = () => 2;' },
  ], '@symbol(observe$)');
  assert.deepEqual(result.entries.map((entry) => entry.path), ['a.ts']);
});
