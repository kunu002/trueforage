import * as vscode from 'vscode';
import type { Studio } from '../src/extension';

/** Desktop preview runner, deliberately distinct from automated test evidence. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<Studio>('trueforage-team.trueforage');
  if (!extension) throw new Error('TrueForage extension not loaded.');
  const studio = await extension.activate();
  if (process.env.TRUEFORAGE_SHOW_PLAYGROUND === '1') {
    await studio.demo();
    await studio.showDiff(studio.changes.list()[1].id);
  } else await studio.openEditor();
  console.log('TrueForage is open. Close this editor window when finished.');
  await new Promise<void>(() => {});
}
