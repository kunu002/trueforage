import { normalizeWorkspacePath } from './paths';

export type ReviewStatus = 'pending' | 'accepted' | 'rejected';

/** Offsets use the same UTF-16 units as VS Code's TextDocument.offsetAt. */
export interface ProposedEdit {
  path: string;
  start: number;
  end: number;
  original: string;
  replacement: string;
  reason?: string;
}

export interface StagedEdit extends ProposedEdit {
  id: string;
  status: ReviewStatus;
}

export interface SelectionBounds {
  start: number;
  end: number;
}

export interface AcceptedOutput {
  path: string;
  original: string;
  content: string;
  editIds: string[];
}

function overlaps(a: SelectionBounds, b: SelectionBounds): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

function copy(edit: StagedEdit): StagedEdit {
  return { ...edit };
}

/**
 * A proposal is inert until a caller applies acceptedOutputs in one WorkspaceEdit.
 * Every proposal refers to an exact snapshot; rebasing edits is deliberately absent.
 */
export class ChangeSet {
  private readonly edits = new Map<string, StagedEdit>();
  private readonly snapshots = new Map<string, string>();
  private nextId = 1;

  stage(input: ProposedEdit, currentContent: string, options: { selection?: SelectionBounds } = {}): StagedEdit {
    const path = normalizeWorkspacePath(input.path);
    const { start, end } = input;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > currentContent.length) {
      throw new Error(`Invalid edit offsets for ${path}.`);
    }
    if (currentContent.slice(start, end) !== input.original) {
      throw new Error(`Stale edit for ${path}: the original text no longer matches.`);
    }
    const selection = options.selection;
    if (selection && (start < selection.start || end > selection.end)) {
      throw new Error(`Edit for ${path} escapes the selected code.`);
    }
    if (this.snapshots.has(path) && this.snapshots.get(path) !== currentContent) {
      throw new Error(`Stale edit for ${path}: the file changed after the proposal began.`);
    }
    for (const edit of this.edits.values()) {
      if (edit.path === path && edit.status !== 'rejected' && overlaps(edit, input)) {
        throw new Error(`Overlapping edit for ${path}: review or discard the existing proposal first.`);
      }
    }
    this.snapshots.set(path, currentContent);
    const edit: StagedEdit = { ...input, path, id: `hunk-${this.nextId++}`, status: 'pending' };
    this.edits.set(edit.id, edit);
    return copy(edit);
  }

  review(id: string, status: 'accepted' | 'rejected'): StagedEdit {
    const edit = this.edits.get(id);
    if (!edit) throw new Error(`Unknown hunk: ${id}.`);
    if (status === 'accepted') {
      for (const other of this.edits.values()) {
        if (other.id !== id && other.path === edit.path && other.status !== 'rejected' && overlaps(other, edit)) {
          throw new Error(`Cannot accept ${id}: it overlaps ${other.id}.`);
        }
      }
    }
    edit.status = status;
    return copy(edit);
  }

  revise(id: string, replacement: string, currentContent: string, reason?: string): StagedEdit {
    const edit = this.edits.get(id);
    if (!edit) throw new Error(`Unknown hunk: ${id}.`);
    if (this.snapshots.get(edit.path) !== currentContent || currentContent.slice(edit.start, edit.end) !== edit.original) {
      throw new Error(`Stale proposal for ${edit.path}: read the current file before proposing another edit.`);
    }
    for (const other of this.edits.values()) {
      if (other.id !== id && other.path === edit.path && other.status !== 'rejected' && overlaps(other, edit)) {
        throw new Error(`Revised hunk ${id} overlaps ${other.id}.`);
      }
    }
    edit.replacement = replacement; edit.status = 'pending';
    if (reason !== undefined) edit.reason = reason;
    return copy(edit);
  }

  list(): StagedEdit[] {
    return [...this.edits.values()].map(copy);
  }

  /** Cancelling a turn discards everything that has not reached the editor. */
  discardPending(): void {
    this.clear();
  }

  clear(): void {
    this.edits.clear();
    this.snapshots.clear();
  }

  /**
   * Validate every accepted file before returning any output. A caller must still
   * check editor versions just before its atomic WorkspaceEdit transaction.
   */
  acceptedOutputs(currentByPath: ReadonlyMap<string, string>): AcceptedOutput[] {
    const grouped = new Map<string, StagedEdit[]>();
    for (const edit of this.edits.values()) {
      if (edit.status !== 'accepted') continue;
      const list = grouped.get(edit.path) ?? [];
      list.push(edit);
      grouped.set(edit.path, list);
    }
    const outputs: AcceptedOutput[] = [];
    for (const [path, edits] of grouped) {
      const original = this.snapshots.get(path)!;
      if (currentByPath.get(path) !== original) {
        throw new Error(`Stale proposal for ${path}: the file changed before apply.`);
      }
      edits.sort((a, b) => a.start - b.start || a.end - b.end);
      let content = '';
      let offset = 0;
      for (const edit of edits) {
        content += original.slice(offset, edit.start) + edit.replacement;
        offset = edit.end;
      }
      content += original.slice(offset);
      outputs.push({ path, original, content, editIds: edits.map((edit) => edit.id) });
    }
    return outputs;
  }
}
