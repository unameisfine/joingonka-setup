/**
 * Безопасное чтение и ТОЧЕЧНАЯ правка YAML-конфигов инструментов (Hermes, omp,
 * MiniMax Code, Goose) — YAML-пара к core/json-config.ts и core/toml-config.ts.
 *
 * ★ Зачем модуль. Правила у всех YAML-адаптеров одни, и до 0.5.0 они жили
 * тремя копиями (omp, minimax-code, goose) плюс четвёртым вариантом в hermes:
 *   1. читаем через Document-API пакета `yaml` (parseDocument), правим setIn /
 *      deleteIn — комментарии, порядок ключей и чужие разделы остаются как были;
 *   2. файл, который нельзя разобрать, или корень-не-map → ОТКАЗ (исключение) и
 *      ни одной записи на диск. Вызывающий к этому моменту ничего не записал и
 *      бэкапа не делал;
 *   3. итоговый текст ОБЯЗАН разбираться — на диск не уходит то, что сломает
 *      инструмент (то же правило у applyJsonEdits и applyTomlEdits);
 *   4. длинные строки не переносятся (`lineWidth: 0`). По умолчанию `yaml` при
 *      записи сворачивает всё, что длиннее 80 колонок, — то есть переписывает
 *      ЧУЖИЕ значения (длинный system_prompt, URL), которых установщик не
 *      касался. Так вёл себя Hermes-адаптер до 0.5.0.
 *
 * ★ Вызывать ДО бэкапа и записи: любой отказ обязан оставить диск нетронутым —
 * ни записи, ни лишнего `.bak`. Порядок в адаптере: прочитать всё → посчитать
 * итоговые тексты → backup → atomicWrite.
 *
 * В текст ошибок содержимое файла не попадает: в этих конфигах лежат API-ключи
 * (Hermes — model.api_key, Goose — secrets.yaml, omp и mcode — ключи чужих
 * провайдеров), а сообщение парсера содержит выдержку из файла. Берём только
 * код ошибки и номер строки.
 */
import { Document, isMap, isScalar, parseDocument } from 'yaml';

/** Общая концовка отказа — та же, что у core/json-config и core/toml-config. */
export const YAML_REFUSAL_HINT =
  'Nothing was written — fix the file (or move it aside) and run the installer again.';

const ISSUES_URL = 'https://github.com/unameisfine/joingonka-setup/issues';

/**
 * Разбирает YAML-файл в документ для точечных правок. Файла нет (`null`), он
 * пуст или в нём одни комментарии → пустой документ (комментарии сохраняются).
 *
 * Бросает исключение на битом YAML и на корне-не-map (скаляр, список): стартовать
 * с пустого документа значило бы перезаписать файл и унести всё, что в нём жило
 * (у Hermes до 0.4.5 так терялись mcp_servers, память и расписания).
 */
export function loadYamlMap(raw: string | null, filePath: string): Document {
  if (raw == null || raw.trim() === '') {
    return new Document({});
  }
  const doc = parseDocument(raw);
  const first = doc.errors[0];
  if (first) {
    const line = first.linePos?.[0]?.line;
    throw new Error(
      `${filePath} is not valid YAML (${first.code}${line ? ` at line ${line}` : ''}). ` +
        YAML_REFUSAL_HINT,
    );
  }
  if (doc.contents != null && !isMap(doc.contents)) {
    throw new Error(
      `${filePath} does not contain a YAML mapping at the top level. ${YAML_REFUSAL_HINT}`,
    );
  }
  return doc;
}

/**
 * Готовит путь к вложенному map перед `setIn`:
 *   узла нет или это map            → ничего не делаем (setIn создаст map сам);
 *   пустой скаляр (`key:`)          → убираем, иначе setIn бросит исключение;
 *   что-то иное и `replace`         → убираем: ключ НАШ, мусор на его месте
 *                                     заменяется (providers.joingonka и т.п.);
 *   что-то иное без `replace`       → отказ: ключ пользователя, значение он мог
 *                                     положить намеренно — не затираем.
 */
export function ensureMapAt(
  doc: Document,
  path: readonly string[],
  filePath: string,
  replace = false,
): void {
  const node = doc.getIn(path, true);
  if (node === undefined || isMap(node)) return;
  if (replace || (isScalar(node) && node.value == null)) {
    doc.deleteIn(path);
    return;
  }
  throw new Error(`${filePath}: "${path.join('.')}" must be a mapping. ${YAML_REFUSAL_HINT}`);
}

/**
 * Текст документа после правок: без переноса длинных строк (чужие значения не
 * «переформатируются») и с проверкой, что результат разбирается.
 */
export function renderYaml(doc: Document, filePath: string): string {
  const text = doc.toString({ lineWidth: 0 });
  if (parseDocument(text).errors.length > 0) {
    throw new Error(
      `Internal error: the edited ${filePath} would no longer be valid YAML. Nothing was ` +
        `written — please report this at ${ISSUES_URL}`,
    );
  }
  return text;
}
