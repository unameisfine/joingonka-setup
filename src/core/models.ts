/**
 * Разбор значения `--model`: алиасы, каноничный регистр, отказ на выведенные
 * из сети модели.
 *
 * ★ Почему это отдельный шаг, а не «передать строку в адаптер».
 * Состав сети Gonka меняется чаще, чем живут инструкции: Kimi K2.6 и GLM-5.2
 * выведены из сети 11.09.2026, а `--model kimi` продолжал попадать в конфиг
 * дословно. Итог у пользователя: конфиг с несуществующей моделью, 400 от
 * шлюза на live-проверке и «установка провалилась» без объяснения. Проверка
 * стоит ДО записи — конфиг не портится вовсе.
 *
 * Полный незнакомый id вида `вендор/модель` пропускаем с предупреждением:
 * сеть может получить модель раньше, чем выйдет новая версия установщика, и
 * жёсткий запрет отнял бы этот путь. Короткое незнакомое слово — почти всегда
 * опечатка в алиасе, поэтому отказ.
 */
import { DEFAULT_MODEL, DEEPSEEK_MODEL, GLM_MODEL, OPENCLAW_MODELS } from '../constants.js';

/** Короткие алиасы CLI → каноничный id модели. */
const ALIASES: Readonly<Record<string, string>> = {
  minimax: DEFAULT_MODEL,
  deepseek: DEEPSEEK_MODEL,
  glm: GLM_MODEL,
};

/**
 * Модели, которые сеть больше не обслуживает. Ключ — в нижнем регистре
 * (и полный id, и короткое имя из старых инструкций), значение — как назвать
 * её человеку. Сверять при смене состава сети: SSOT — `/v1/models` шлюза.
 */
const RETIRED: Readonly<Record<string, string>> = {
  kimi: 'Kimi K2.6',
  'kimi-k2.6': 'Kimi K2.6',
  'moonshotai/kimi-k2.6': 'Kimi K2.6',
  'glm-5.2': 'GLM-5.2-FP8',
  'zai-org/glm-5.2-fp8': 'GLM-5.2-FP8',
  qwen: 'Qwen3',
  qwen3: 'Qwen3',
  'qwen/qwen3-235b-a22b': 'Qwen3 235B',
};

/** Каталог установщика: нижний регистр id → каноничный id. */
const CATALOG = new Map(OPENCLAW_MODELS.map((m) => [m.id.toLowerCase(), m.id]));

/** Что делать пользователю, если его модель не подходит. */
const ALTERNATIVES =
  'Use --model minimax | deepseek | glm, or a model id from ' +
  'https://gate.joingonka.ai/v1/models.';

/** Результат разбора: итоговый id и необязательное предупреждение. */
export interface ResolvedModel {
  model: string;
  /** Непустое, если id не из каталога установщика (запись всё равно выполняется). */
  warning?: string;
}

/**
 * Приводит значение `--model` к id модели.
 *
 * @param input          значение флага (undefined/пусто → дефолт);
 * @param adapterDefault пер-инструментный дефолт (у кодовых агентов — DeepSeek).
 * @throws Error если модель выведена из сети либо это незнакомый короткий алиас.
 */
export function canonicalModel(input?: string, adapterDefault?: string): ResolvedModel {
  const raw = (input ?? '').trim();
  if (raw === '') {
    return { model: adapterDefault ?? DEFAULT_MODEL };
  }

  const key = raw.toLowerCase();

  const retired = RETIRED[key];
  if (retired) {
    throw new Error(
      `${retired} is no longer served by the Gonka network, so the config was not touched. ` +
        ALTERNATIVES,
    );
  }

  const alias = ALIASES[key];
  if (alias) {
    return { model: alias };
  }

  const canonical = CATALOG.get(key);
  if (canonical) {
    return { model: canonical };
  }

  if (!raw.includes('/')) {
    throw new Error(`Unknown model "${raw}", so the config was not touched. ${ALTERNATIVES}`);
  }

  return {
    model: raw,
    warning:
      `Model "${raw}" is not in this installer's catalog — writing it as given. ` +
      `If the tool reports an unknown model, check https://gate.joingonka.ai/v1/models.`,
  };
}
