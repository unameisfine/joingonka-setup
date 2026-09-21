/**
 * Выбор файла для записи у инструментов со СЛОЁНЫМ глобальным конфигом —
 * opencode и его форк Kilo Code.
 *
 * ★ Зачем модуль (находка аудита 0.5.0). Эти инструменты читают из каталога
 * конфига НЕСКОЛЬКО файлов и сливают их по возрастанию приоритета (remeda
 * mergeDeep: объекты сливаются рекурсивно, скаляры и массивы берутся из файла
 * выше). До 0.5.0 установщик всегда писал в один и тот же файл (opencode.json,
 * kilo.jsonc). Но с 12.05.2026 opencode при первом старте сам создаёт
 * `opencode.jsonc` (коммит 48757577, «create global opencode.jsonc if no configs
 * exist»), а он ВЫШЕ `opencode.json`: стоило человеку (или самому инструменту)
 * записать туда `model`, как наш `--model` из opencode.json переставал
 * действовать — установщик рапортовал «Default model: …», live-проверка
 * подтверждала модель, а инструмент стартовал с другой.
 *
 * Правило: пишем в СУЩЕСТВУЮЩИЙ файл с наивысшим приоритетом загрузки — тогда всё
 * записанное гарантированно действует, потому что остальные глобальные файлы
 * ниже. Нет ни одного — создаём файл по умолчанию. Остальные существующие файлы
 * (`lower`) нужны адаптеру для двух вещей:
 *   - унаследованная `model` (inheritedModel): выбор пользователя из файла ниже
 *     действует, пока целевой файл модель не задаёт, и перебивать его своим
 *     дефолтом нельзя;
 *   - наследие прежних версий установщика: наш блок провайдера и ссылки на
 *     ушедшие модели могли остаться в файле ниже — их адаптер приводит в порядок
 *     там же, иначе слияние вернуло бы убранные модели в каталог.
 *
 * Порядок загрузки — ТОЛЬКО по исходникам инструмента (дока называет один файл);
 * URL и дата сверки — в шапке адаптера. Тот же приём раньше появился в
 * adapters/mimo-code.ts (ещё один форк opencode).
 */
import { existsSync } from 'node:fs';
import { readRaw } from './fs-ops.js';
import { readJsonConfig, type JsonConfigDoc } from './json-config.js';
import { pathApi, type PathContext } from './paths.js';

/** Что выбрано для записи и что лежит ниже по приоритету. */
export interface LayeredConfigFiles {
  /** Файл, в который пишем: существующий с наивысшим приоритетом либо файл по умолчанию. */
  target: string;
  /** Остальные СУЩЕСТВУЮЩИЕ глобальные файлы по убыванию приоритета — все ниже `target`. */
  lower: string[];
}

export interface LayeredConfigOptions {
  /** Каталог глобального конфига инструмента. */
  dir: string;
  /** Имена глобальных файлов по УБЫВАНИЮ приоритета загрузки. */
  names: readonly string[];
  /** Какой файл создать, если нет ни одного (обязан входить в `names`). */
  defaultName: string;
  /**
   * Файл-слой, который инструмент грузит ПОВЕРХ глобальных (OPENCODE_CONFIG,
   * KILO_CONFIG). Задан — пишем в него: он выше любого глобального файла.
   */
  override?: string;
  ctx: PathContext;
}

/** Выбирает файл для записи (см. шапку модуля). */
export function pickLayeredConfig(options: LayeredConfigOptions): LayeredConfigFiles {
  const { join } = pathApi(options.ctx);
  const existing = options.names
    .map((name) => join(options.dir, name))
    .filter((file) => existsSync(file));

  if (options.override !== undefined) {
    return { target: options.override, lower: existing.filter((file) => file !== options.override) };
  }
  const [target, ...lower] = existing;
  return { target: target ?? join(options.dir, options.defaultName), lower };
}

/** Разобранный файл ниже целевого по приоритету. */
export interface LowerConfig {
  path: string;
  doc: JsonConfigDoc;
}

/**
 * Читает файлы ниже целевого. Неразбираемый файл — НЕ отказ: это не наш адресат,
 * установка в целевой файл от него не зависит. Он попадает в `unreadable`, и
 * адаптер говорит о нём пользователю, но не трогает.
 */
export function readLowerConfigs(paths: readonly string[]): {
  docs: LowerConfig[];
  unreadable: string[];
} {
  const docs: LowerConfig[] = [];
  const unreadable: string[] = [];
  for (const path of paths) {
    try {
      docs.push({ path, doc: readJsonConfig(readRaw(path), path) });
    } catch {
      unreadable.push(path);
    }
  }
  return { docs, unreadable };
}

/**
 * `model`, которая действует из файлов НИЖЕ целевого: значение из первого по
 * приоритету файла, где она задана. undefined — ниже модель никто не выбирал.
 */
export function inheritedModel(lower: readonly LowerConfig[]): string | undefined {
  for (const { doc } of lower) {
    const model = doc.value.model;
    if (typeof model === 'string' && model.trim() !== '') return model;
  }
  return undefined;
}
