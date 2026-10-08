import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/ui', { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  cpSync(`src/ui/${file}`, `dist/ui/${file}`);
}
