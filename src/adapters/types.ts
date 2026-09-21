/**
 * Контракт адаптера инструмента.
 *
 * Каждый поддерживаемый инструмент (Claude Code, OpenClaw, Cline) реализует
 * Adapter. Общий core (fs-ops, merge, validate) не знает о конкретных
 * инструментах — он работает через этот интерфейс. Добавление нового
 * инструмента = новый адаптер + запись в registry, без правок оркестратора.
 */

import type { LivePricing } from '../core/pricing.js';
import type { VerifyApiMode } from '../core/verify.js';

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
  /**
   * Пользователь задал модель явно (`--model`), а не получил дефолт.
   *
   * Различие принципиальное: явную модель адаптер ОБЯЗАН записать в конфиг
   * (иначе флаг молча не действует — до 0.4.5 так и было у claude-code,
   * openclaw, opencode, kilo и zed, а live-проверка при этом бодро
   * подтверждала «Verified» для модели, которой в конфиге нет). Без флага
   * действует прежнее правило: чужой рабочий выбор пользователя не трогаем.
   */
  modelExplicit?: boolean;
  /**
   * Живые цены моделей на момент установки (core/pricing.ts) — для адаптеров,
   * которые пишут в конфиг цену (OpenClaw, Pi, omp, Crush). Оркестратор запрашивает
   * их один раз и только для адаптера с `wantsPricing`. Нет поля или `null` (шлюз
   * недоступен, тесты) → адаптер НЕ трогает цену, уже записанную у модели, а
   * константу-фолбэк пишет только новой записи.
   */
  pricing?: LivePricing | null;
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
  /**
   * Формат родного конфига инструмента: 'json' (в том числе JSONC), 'yaml',
   * 'toml' (Codex CLI, Kimi Code CLI — core/toml-config.ts) либо 'instructions'
   * — файл не пишется, печатается инструкция для ручного ввода.
   */
  readonly format: 'json' | 'yaml' | 'toml' | 'instructions';

  /**
   * Как инструмент обращается к нашему gateway — определяет endpoint live-проверки
   * (core/verify): 'openai' → /v1/chat/completions (Bearer), 'anthropic' →
   * /v1/messages (x-api-key, только claude-code), 'responses' → /v1/responses
   * (Bearer, Codex CLI). По умолчанию 'openai'.
   *
   * ★ Режим обязан совпадать с протоколом, которым инструмент реально ходит в
   * шлюз: «✓ Verified» по чужому маршруту подтверждает не ту настройку.
   */
  readonly apiMode?: VerifyApiMode;

  /**
   * Модель по умолчанию именно для этого инструмента (когда пользователь не
   * задал --model). Пусто → общий DEFAULT_MODEL. Нужен там, где профиль работы
   * инструмента требует другой модели: автономному агенту важнее длинный
   * контекст и потолок ответа, чем универсальность.
   */
  readonly defaultModel?: string;

  /**
   * Инструмент умеет конфигурацию внутри проекта (`--scope local`).
   *
   * Таких меньшинство: у большинства инструментов конфиг один на пользователя,
   * и раньше `--scope local` для них молча писал в глобальный файл, хотя CLI и
   * README обещали установку «в текущий проект».
   */
  readonly supportsLocalScope?: boolean;

  /**
   * Адаптер пишет в конфиг цены моделей и хочет получить живые
   * (`ApplyInput.pricing`). Остальным инструментам цена не нужна, и ходить
   * ради них в сеть перед установкой незачем.
   */
  readonly wantsPricing?: boolean;

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
