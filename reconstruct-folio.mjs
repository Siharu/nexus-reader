import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const folioDir = path.join(root, 'folio');
const partsDir = path.join(folioDir, '.folio-source');
const tempDir = path.join('/tmp', 'folio-reconstruction');
const archivePath = path.join('/tmp', 'folio-source.zip');

const partNames = (await fs.readdir(partsDir))
  .filter((name) => /^part\d+\.b64$/.test(name))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
if (partNames.length < 10) throw new Error(`Expected the complete Folio archive, found ${partNames.length} parts.`);

const encoded = (await Promise.all(partNames.map((name) => fs.readFile(path.join(partsDir, name), 'utf8')))).join('');
const archive = Buffer.from(encoded, 'base64');
if (archive.length < 1000 || archive[0] !== 0x50 || archive[1] !== 0x4b) {
  throw new Error('Folio source archive is incomplete or corrupt.');
}
await fs.writeFile(archivePath, archive);
await fs.rm(tempDir, { recursive: true, force: true });
execFileSync('unzip', ['-q', '-o', archivePath, '-d', tempDir], { stdio: 'inherit' });

const sourceDir = path.join(tempDir, 'personal-manga-platform');
for (const name of await fs.readdir(sourceDir)) {
  if (name === '.git') continue;
  const from = path.join(sourceDir, name);
  const to = name === 'README.md' ? path.join(folioDir, 'APP_README.md') : path.join(folioDir, name);
  await fs.cp(from, to, { recursive: true, force: true });
}
await fs.rm(partsDir, { recursive: true, force: true });
await fs.rm(archivePath, { force: true });
await fs.rm(tempDir, { recursive: true, force: true });
console.log('Folio source reconstructed successfully.');
