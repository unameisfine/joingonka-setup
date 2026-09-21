#!/usr/bin/env node
/**
 * Гейт публикации: публикуем ТОЛЬКО из чистого закоммиченного дерева.
 *
 * Зовётся из `prepublishOnly` (package.json) перед сборкой и тестами.
 *
 * ★ Зачем. `tsc` собирает всё, что лежит в src/, а `npm publish` упаковывает
 * dist/ как есть. Значит, в npm уезжает содержимое РАБОЧЕГО КАТАЛОГА, а не
 * коммита: незакоммиченная правка и даже новый неотслеживаемый файл попадают к
 * пользователям, а в репозитории их нет — опубликованную версию потом нечем
 * воспроизвести и не с чем сравнить.
 *
 * Почему `git status --porcelain`, а не `git diff --quiet HEAD`: второй видит
 * только ОТСЛЕЖИВАЕМЫЕ файлы. Новый адаптер, который забыли добавить в индекс,
 * он пропускает — а это самый частый случай (в проекте уже был коммит,
 * потерявший 16 новых файлов, потому что pathspec-форма их не берёт).
 * Игнорируемое (dist/, node_modules/) в выдачу не попадает.
 *
 * Следствие для порядка релиза: bump версии → КОММИТ → publish (раньше коммит
 * шёл последним шагом).
 *
 * Обычный .mjs без зависимостей: работает одинаково на Linux, macOS и Windows,
 * в отличие от shell-конструкции в самой строке scripts.
 */
import { execFileSync } from 'node:child_process';

let status;
try {
  status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
} catch (err) {
  console.error('Refusing to publish: cannot read the git state of this directory.');
  console.error(`  ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  process.exit(1);
}

const dirty = status.split('\n').filter((line) => line.trim() !== '');
if (dirty.length > 0) {
  console.error('Refusing to publish: the working tree has changes that are not committed.');
  console.error('npm would ship them, and the repository would not contain the released code.');
  console.error('');
  for (const line of dirty) console.error(`  ${line}`);
  console.error('');
  console.error('Commit (or remove) these files, then run `npm publish` again.');
  process.exit(1);
}
