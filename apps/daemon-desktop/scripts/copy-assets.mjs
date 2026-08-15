/* Copies the non-TypeScript renderer files and the icon into dist/. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererOut = path.join(root, 'dist', 'renderer');
const assetsOut = path.join(root, 'dist', 'assets');

fs.mkdirSync(rendererOut, { recursive: true });
fs.mkdirSync(assetsOut, { recursive: true });

for (const file of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(root, 'src', 'renderer', file), path.join(rendererOut, file));
}

const icon = path.join(root, 'build', 'icon.png');
if (!fs.existsSync(icon)) {
  console.error('build/icon.png is missing — run "node scripts/make-icon.mjs" first.');
  process.exit(1);
}
fs.copyFileSync(icon, path.join(assetsOut, 'icon.png'));

console.log('assets copied to dist/');
