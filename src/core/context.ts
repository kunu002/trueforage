import { normalizeWorkspacePath } from './paths';

export const MAX_CONTEXT_BYTES = 24_000;

export interface ContextDocument {
  path: string;
  content: string;
}

export interface ContextDirectives {
  files: string[];
  symbols: string[];
}

export interface ContextEntry {
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  /** Bytes of the rendered header and excerpt, including separators. */
  bytes: number;
  content: string;
  score: number;
  truncated?: boolean;
}

export interface ContextResult {
  entries: ContextEntry[];
  usedBytes: number;
  budgetBytes: number;
  directives: ContextDirectives;
}

export interface ContextOptions {
  budgetBytes?: number;
  windowLines?: number;
  strideLines?: number;
}

const stopWords = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'into', 'must', 'should',
  'add', 'new', 'make', 'please', 'some', 'have', 'has', 'its', 'which', 'when',
  'all', 'any', 'are', 'was', 'will', 'can', 'use', 'using', 'also', 'only',
  'file', 'files', 'code', 'update', 'change', 'changes', 'implement', 'need',
  'you', 'your', 'want', 'would', 'could', 'value', 'values', 'case', 'well',
  'as', 'at', 'be', 'by', 'do', 'an', 'if', 'in', 'is', 'it', 'of', 'on', 'or',
  'so', 'to', 'up', 'we', 'no', 'not', 'then', 'than', 'these', 'those', 'them',
]);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function parseContextDirectives(prompt: string): ContextDirectives {
  const files: string[] = [];
  const symbols: string[] = [];
  for (const match of prompt.matchAll(/@(file|symbol)\(([^)\r\n]+)\)/g)) {
    const value = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (match[1] === 'file') files.push(normalizeWorkspacePath(value));
    else if (/^[\w.$:<>/-]+$/.test(value)) symbols.push(value);
  }
  return { files: unique(files), symbols: unique(symbols) };
}

function termsFor(prompt: string): string[] {
  const stripped = prompt.replace(/@(file|symbol)\([^)]+\)/g, ' ');
  return unique((stripped.toLowerCase().match(/[a-z_][a-z0-9_]{1,}/g) ?? []).filter((term) => !stopWords.has(term))).slice(0, 40);
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsSymbol(text: string, symbol: string): boolean {
  const leaf = symbol.split(/[.:]/).filter(Boolean).at(-1) ?? symbol;
  return new RegExp(`(?<![\\w$])${escaped(leaf)}(?![\\w$])`).test(text);
}

function definitions(text: string): string[] {
  const result: string[] = [];
  const pattern = /(?:\b(?:async\s+)?(?:def|class|function|interface|type|enum|struct|fn)\s+([\w$]+)|\b(?:const|let|var)\s+([\w$]+)\s*=|^\s*(?:export\s+)?(?:async\s+)?([\w$]+)\s*\([^\n]*\)\s*[:{])/gm;
  for (const match of text.matchAll(pattern)) result.push(match[1] ?? match[2] ?? match[3]!);
  return result;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function entryHeader(entry: Pick<ContextEntry, 'path' | 'startLine' | 'endLine' | 'reason'>): string {
  return `\n--- ${entry.path}:${entry.startLine}-${entry.endLine} | ${entry.reason} ---\n`;
}

export function renderContextEntry(entry: ContextEntry): string {
  return entryHeader(entry) + entry.content + '\n';
}

export function renderContext(result: ContextResult): string {
  return result.entries.map(renderContextEntry).join('');
}

/** Take whole Unicode code points; never emit a replacement character at the budget edge. */
function prefixWithinBytes(value: string, maxBytes: number): string {
  let end = 0;
  let bytes = 0;
  for (const character of value) {
    const count = byteLength(character);
    if (bytes + count > maxBytes) break;
    bytes += count;
    end += character.length;
  }
  return value.slice(0, end);
}

/**
 * Budgeted local retrieval. It ranks overlapping 60-line excerpts using query
 * terms, path matches and declarations, with explicit references taking priority.
 * Source content is returned as evidence; callers must not treat it as instructions.
 */
export function retrieveContext(documents: readonly ContextDocument[], prompt: string, options: ContextOptions = {}): ContextResult {
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined && !Number.isFinite(value)) throw new Error(`Context option ${name} must be finite.`);
  }
  const budgetBytes = Math.max(0, Math.min(MAX_CONTEXT_BYTES, Math.floor(options.budgetBytes ?? MAX_CONTEXT_BYTES)));
  const windowLines = Math.max(1, Math.floor(options.windowLines ?? 60));
  const strideLines = Math.max(1, Math.min(windowLines, Math.floor(options.strideLines ?? 30)));
  const directives = parseContextDirectives(prompt);
  const terms = termsFor(prompt);
  const candidates: ContextEntry[] = [];
  for (const document of documents) {
    const path = normalizeWorkspacePath(document.path);
    const lowerPath = path.toLowerCase();
    const pathTerms = terms.filter((term) => lowerPath.includes(term));
    const explicitFile = directives.files.some((reference) => reference === path);
    const lines = document.content.split(/\r?\n/);
    for (let start = 0; start < lines.length; start += strideLines) {
      const content = lines.slice(start, start + windowLines).join('\n');
      if (!content.trim()) continue;
      const lowerContent = content.toLowerCase();
      const hits = terms.filter((term) => lowerContent.includes(term));
      const symbolHits = directives.symbols.filter((symbol) => mentionsSymbol(content, symbol));
      const declarationHits = definitions(content).filter((name) => terms.some((term) => name.toLowerCase().includes(term)) || directives.symbols.includes(name));
      const score = (explicitFile ? 1_000 : 0) + symbolHits.length * 700 + pathTerms.length * 25 + declarationHits.length * 12 + hits.length * 4;
      if (score === 0) continue;
      const reasons: string[] = [];
      if (explicitFile) reasons.push('explicit @file reference');
      if (symbolHits.length) reasons.push(`@symbol ${symbolHits.slice(0, 3).join(', ')}`);
      if (pathTerms.length) reasons.push(`path: ${pathTerms.slice(0, 4).join(', ')}`);
      if (declarationHits.length) reasons.push(`definitions: ${unique(declarationHits).slice(0, 3).join(', ')}`);
      if (hits.length) reasons.push(`terms: ${hits.slice(0, 5).join(', ')}`);
      const entry: ContextEntry = { path, startLine: start + 1, endLine: Math.min(lines.length, start + windowLines), reason: reasons.join('; '), content, score, bytes: 0 };
      entry.bytes = byteLength(renderContextEntry(entry));
      candidates.push(entry);
      if (start + windowLines >= lines.length) break;
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  const entries: ContextEntry[] = [];
  let usedBytes = 0;
  const fits = (entry: ContextEntry) => !entries.some((selected) => selected.path === entry.path && selected.startLine <= entry.endLine && entry.startLine <= selected.endLine);
  // One best excerpt from each relevant file first, so large files cannot hide tests/docs.
  const seen = new Set<string>();
  const firstPass: ContextEntry[] = [];
  const secondPass: ContextEntry[] = [];
  for (const entry of candidates) {
    if (seen.has(entry.path)) secondPass.push(entry);
    else { seen.add(entry.path); firstPass.push(entry); }
  }
  for (const candidate of [...firstPass, ...secondPass]) {
    if (!fits(candidate)) continue;
    const available = budgetBytes - usedBytes;
    let entry = candidate;
    if (entry.bytes > available) {
      const overhead = byteLength(entryHeader(entry) + '\n');
      if (available <= overhead) continue;
      const content = prefixWithinBytes(entry.content, available - overhead);
      if (!content.trim()) continue;
      entry = { ...entry, content, endLine: entry.startLine + content.split('\n').length - 1, truncated: true };
      entry.bytes = byteLength(renderContextEntry(entry));
      // A shorter line-range header may free a few bytes; never exceed the limit.
      if (entry.bytes > available) continue;
    }
    entries.push(entry);
    usedBytes += entry.bytes;
    if (usedBytes >= budgetBytes) break;
  }
  return { entries, usedBytes, budgetBytes, directives };
}
