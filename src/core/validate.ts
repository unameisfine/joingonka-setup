/**
 * Валидация JoinGonka API-ключа.
 *
 * Все ключи JoinGonka имеют префикс `jg-`. Проверяем именно префикс,
 * а не просто наличие подстроки, чтобы отсеять чужие форматы ключей
 * (sk-..., и т.п.) до записи их в конфиг.
 *
 * Сигнатура `true | string` совместима с опцией `validate`
 * из @inquirer/prompts — то же значение используется и в password-промпте.
 */
export function validateApiKey(value: string): true | string {
  // Обрезаем пробелы: ввод вида "   " не должен считаться валидным
  const v = (value ?? '').trim();
  if (!v) {
    return 'API key is required';
  }
  if (!v.startsWith('jg-')) {
    return 'API key must start with jg-';
  }
  return true;
}
