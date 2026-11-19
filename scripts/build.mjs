import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const result = await build({ entryPoints: ['src/extension.ts'], bundle: true, outfile: 'dist/extension.js',
  external: ['vscode'], platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, metafile: true, logLevel: 'info' });
const packageRoots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const index = input.lastIndexOf('node_modules/');
  if (index < 0) continue;
  const pieces = input.slice(index + 'node_modules/'.length).split('/');
  const name = pieces[0].startsWith('@') ? pieces.slice(0, 2).join('/') : pieces[0];
  packageRoots.add(input.slice(0, index) + 'node_modules/' + name);
}
const notices = ['# Third-party notices', '', 'Generated from the packages included in the extension bundle. Their licences apply to their respective code.', ''];
for (const root of [...packageRoots].sort()) {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  notices.push(`## ${metadata.name} ${metadata.version}`, '', `Declared licence: ${metadata.license || 'See package source'}`, '');
  const licences = (await readdir(root)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)).sort();
  for (const licence of licences) notices.push(await readFile(path.join(root, licence), 'utf8'), '');
  if (!licences.length) throw new Error(`Bundled package ${metadata.name} has no licence notice. Review it before packaging.`);
}
await writeFile('THIRD_PARTY_NOTICES.md', notices.join('\n'));
await build({ entryPoints: ['test/host.ts'], bundle: true, outfile: 'dist/host.js',
  external: ['vscode'], platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning' });
await build({ entryPoints: ['test/showcase.ts'], bundle: true, outfile: 'dist/showcase.js',
  external: ['vscode'], platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning' });
await build({ entryPoints: ['test/real-host.ts'], bundle: true, outfile: 'dist/real-host.js',
  external: ['vscode'], platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning' });
