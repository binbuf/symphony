/* Copy prompt templates into dist/ so the compiled build can read them at runtime. */
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'prompts');
const to = join(root, 'dist', 'prompts');

mkdirSync(to, { recursive: true });
for (const entry of readdirSync(from, { withFileTypes: true })) {
  if (entry.isFile()) cpSync(join(from, entry.name), join(to, entry.name));
}