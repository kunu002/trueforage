import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { normalizeWorkspacePath } from './core/paths';
import { parseContextDirectives, type ContextDocument } from './core/context';

const excluded = '**/{node_modules,.git,.venv,venv,dist,build,.test-build,.host-test,.trueforge,coverage,__pycache__,.next}/**';

export class Workspace {
  constructor(readonly root: vscode.Uri) {}

  async uri(input: string, allowMissing = false): Promise<vscode.Uri> {
    const relative = normalizeWorkspacePath(input);
    if (relative.split('/').some(segment => segment === '.git' || segment === '.env' || segment.startsWith('.env.') || segment === '.aws' || segment === '.ssh')) {
      throw new Error('Private configuration and repository internals are excluded.');
    }
    const absolute = path.join(this.root.fsPath, relative);
    const rootReal = await fs.realpath(this.root.fsPath);
    let probe = absolute;
    while (true) {
      try {
        // lstat distinguishes a missing path from an existing dangling symlink.
        // The latter must not become an allowed new file by walking to its parent.
        await fs.lstat(probe);
      } catch (error) {
        if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        probe = path.dirname(probe);
        continue;
      }
      const real = await fs.realpath(probe);
      const inside = path.relative(rootReal, real);
      if (inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside)) throw new Error('Path leaves the workspace through a symlink.');
      break;
    }
    return vscode.Uri.file(absolute);
  }

  async read(input: string, allowMissing = false): Promise<{ content: string; doc?: vscode.TextDocument; exists: boolean }> {
    const uri = await this.uri(input, allowMissing);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (Buffer.byteLength(doc.getText(), 'utf8') > 1_000_000) throw new Error('File is larger than the 1 MB read limit.');
      if (doc.getText().includes('\0')) throw new Error('Binary files cannot be inspected or edited.');
      return { content: doc.getText(), doc, exists: true };
    } catch (error) {
      // openTextDocument errors are not guaranteed to carry ENOENT.
      if (allowMissing) {
        try { await fs.stat(uri.fsPath); } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', exists: false };
        }
      }
      throw error;
    }
  }

  async files(glob = '**/*'): Promise<string[]> {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root, glob), excluded, 2000);
    return uris.map(uri => path.relative(this.root.fsPath, uri.fsPath).replace(/\\/g, '/'))
      .filter(p => !p.split('/').some(part => part === '.env' || part.startsWith('.env.') || part === '.aws' || part === '.ssh'))
      .sort();
  }

  async documents(query: string): Promise<ContextDocument[]> {
    const files = await this.files();
    const explicit = new Set(parseContextDirectives(query).files);
    // Bound scanning independently of the returned context budget.
    const terms = query.toLowerCase().match(/[a-z_]{3,}/g) ?? [];
    // Exact references also work outside the discovery cap and for extensionless files.
    const ranked = [...new Set([...explicit, ...files])]
      .map(file => ({ file, explicit: explicit.has(file), score: terms.filter(term => file.toLowerCase().includes(term)).length }))
      .sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || a.file.localeCompare(b.file));
    const documents: ContextDocument[] = [];
    let bytes = 0;
    for (const { file, explicit } of ranked) {
      if (documents.length >= 240 || bytes >= 8_000_000) break;
      if (!explicit && !/\.(?:py|[cm]?[jt]sx?|rs|go|java|c|cpp|h|md|rst|txt|json|toml|ya?ml|sh|html|css|vue|svelte)$/i.test(file)) continue;
      try {
        const uri = await this.uri(file);
        const stat = await fs.stat(uri.fsPath);
        if (stat.size > 256_000) continue;
        const { content } = await this.read(file);
        documents.push({ path: file, content }); bytes += Buffer.byteLength(content, 'utf8');
      } catch { /* Skip inaccessible, binary and escaping paths. */ }
    }
    return documents;
  }
}
