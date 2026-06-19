/**
 * Формат-агностичные файловые операции: чтение, бэкап, атомарная запись.
 *
 * Адаптеры (JSON/YAML) работают через эти примитивы, чтобы логика
 * «прочитать существующее → забэкапить → атомарно записать» была единой
 * и не дублировалась в каждом адаптере.
 */
import writeFileAtomic from 'write-file-atomic';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Читает файл как строку. Возвращает null, если файла нет.
 * Бросает только на реальных ошибках ввода-вывода (права и т.п.).
 */
export function readRaw(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Создаёт бэкап файла с таймстемпом, безопасным для файловых систем.
 *
 * Имя: `<path>.bak.<ISO-с-замещёнными-:.>`. Двоеточия и точки в ISO-метке
 * заменяются на `-`, иначе имя ломается на Windows/некоторых FS.
 *
 * Возвращает путь к бэкапу, либо null если исходного файла нет
 * (бэкапить нечего — это не ошибка).
 */
export function backup(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.bak.${ts}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Атомарная запись: гарантирует существование родительского каталога,
 * затем пишет через write-file-atomic (tmp + rename), чтобы файл никогда
 * не оставался в полу-записанном состоянии.
 *
 * Опциональный `mode` задаёт права создаваемого файла. Мы НЕ полагаемся
 * только на mode из write-file-atomic (его временный файл создаётся с учётом
 * umask, итоговые биты могут отличаться) — после записи права принудительно
 * выставляются через chmod, чтобы гарантировать ровно заданное значение
 * (например 0o600 для файлов с секретами/конфигами инструментов).
 */
export async function atomicWrite(
  filePath: string,
  contents: string,
  mode?: number,
): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (mode === undefined) {
    await writeFileAtomic(filePath, contents);
    return;
  }
  await writeFileAtomic(filePath, contents, { mode });
  // Гарантируем точные биты независимо от umask на этапе создания tmp-файла.
  fs.chmodSync(filePath, mode);
}
