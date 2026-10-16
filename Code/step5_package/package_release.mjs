/** Developer-only packaging. Every distributed file is explicitly allowlisted. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {zipSync, strToU8} from 'fflate';

export const RELEASE_FILES = [
  'README.md', 'LICENSE', 'install.sh', 'notion-export.sh', 'package-lock.json',
  'Code/step1_capture/capture_snapshot.mjs', 'Code/step1_capture/cache_assets.mjs',
  'Code/step2_build/build_offline.mjs', 'Code/step2_build/reader.js', 'Code/step2_build/reader.css',
  'Code/step4_cli/auth.mjs', 'Code/step4_cli/network.mjs', 'Code/step4_cli/notion_client.mjs', 'Code/step4_cli/export_cli.mjs',
];

export async function packageRelease(project, destination) {
  const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  const root = `notion-offline-exporter-${manifest.version}`;
  const files = {};
  for (const filename of RELEASE_FILES) {
    const bytes = new Uint8Array(await readFile(join(project, filename)));
    files[`${root}/${filename}`] = [bytes, {os: 3, attrs: ((filename.endsWith('.sh') ? 0o100755 : 0o100644) << 16) >>> 0}];
  }
  const releaseManifest = {...manifest, scripts: {export: manifest.scripts.export}};
  files[`${root}/package.json`] = [strToU8(JSON.stringify(releaseManifest, null, 2) + '\n'), {os: 3, attrs: (0o100644 << 16) >>> 0}];
  const bytes = zipSync(files, {level: 9});
  const output = destination || join(project, 'dist', root + '.zip');
  await mkdir(dirname(output), {recursive: true});
  await writeFile(output, bytes);
  const report = {version: manifest.version, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), files: Object.keys(files), private_data_included: false};
  await writeFile(output + '.report.json', JSON.stringify(report, null, 2) + '\n');
  return {output, ...report};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  console.log(JSON.stringify(await packageRelease(project), null, 2));
}
