/**
 * Контракт адаптера инструмента.
 *
 * Каждый поддерживаемый инструмент (Claude Code, OpenClaw, Cline) реализует
 * Adapter. Общий core (fs-ops, merge, validate) не знает о конкретных
 * инструментах — он работает через этот интерфейс. Добавление нового
 * инструмента = новый адаптер + запись в registry, без правок оркестратора.
 */

/**
 * Куда устанавливаем конфигурацию:
 * - 'user'  — глобально (домашний каталог пользователя)
 * - 'local' — в текущем проекте (cwd)
 */
export type Scope = 'user' | 'local';

/** Вход для apply(): что именно прописать в конфиг инструмента. */
export interface ApplyInput {
  apiKey: string;
  model: string;
  scope: Scope;
}

/** Результат apply(): что произошло, для вывода пользователю. */
export interface ApplyResult {
  /** Путь к записанному конфигу, либо null для instructions-only инструментов. */
  configPath: string | null;
  /** Путь к созданному бэкапу, либо null если бэкапить было нечего. */
  backupPath: string | null;
  /** Был ли реально записан файл (false для instructions-only). */
  wrote: boolean;
  /** Сообщения пользователю (инструкции, подтверждения, заметки). */
  messages: string[];
}

/** Адаптер одного инструмента. */
export interface Adapter {
  /** Машинный идентификатор: 'claude-code' | 'openclaw' | 'cline'. */
  readonly id: string;
  /** Человекочитаемое имя для меню выбора. */
  readonly label: string;
  /** Формат конфига — определяет ветку записи. */
  readonly format: 'json' | 'yaml' | 'instructions';

  /**
   * Абсолютный путь к целевому файлу конфига для заданного scope,
   * либо null для instructions-only инструментов (ничего не пишем).
   *
   * ВАЖНО: homedir()/cwd() читаются В МОМЕНТ ВЫЗОВА, а не на импорте
   * модуля — иначе тесты не смогут подменять HOME/cwd.
   */
  resolvePath(scope: Scope): string | null;

  /** Применить конфигурацию (записать файл либо вернуть инструкции). */
  apply(input: ApplyInput): Promise<ApplyResult>;
}
