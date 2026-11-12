// Copies the exact Lucide icon geometry used by the Electron client.
// Run from any directory after npm install in the repository root.
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'rust/app/assets');
const icons = ['house', 'search', 'arrow-left', 'arrow-right', 'external-link', 'message-square', 'panel-right-close', 'panel-right-open', 'panel-left-close', 'panel-left-open', 'picture-in-picture-2', 'rectangle-horizontal', 'maximize', 'minimize', 'play', 'pause', 'volume-2', 'volume-x', 'smile', 'send', 'x', 'users', 'clock-3', 'refresh-cw', 'log-out', 'log-in', 'chevron-down', 'chevron-up', 'arrow-down', 'radio', 'heart', 'check', 'monitor', 'settings', 'reply', 'copy'];
await mkdir(path.join(output, 'icons'), { recursive: true });
const escape = s => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
for (const name of icons) {
  const { __iconNode } = await import(pathToFileURL(path.join(root, `node_modules/lucide-react/dist/esm/icons/${name}.mjs`)));
  const nodes = __iconNode.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([key]) => key !== 'key').map(([key, value]) => `${key}="${escape(value)}"`).join(' ')}/>`).join('');
  await writeFile(path.join(output, `icons/${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${nodes}</svg>\n`);
}
await copyFile(path.join(root, 'node_modules/lucide-react/LICENSE'), path.join(output, 'LUCIDE-LICENSE'));
await copyFile(path.join(root, 'src/renderer/src/assets/violetwire-icon.png'), path.join(output, 'violetwire-icon.png'));
console.log(`Synced ${icons.length} Lucide icons and the existing VioletWire logo.`);
