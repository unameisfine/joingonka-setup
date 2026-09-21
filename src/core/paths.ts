/**
 * Общие кирпичи для путей к конфигам инструментов.
 *
 * ★ Зачем. Путь к конфигу зависит от платформы и окружения, а тесты идут на
 * одной машине. Поэтому всё, от чего путь зависит, собрано в PathContext и
 * передаётся параметром: тест подставляет `platform: 'win32'` и проверяет
 * Windows-путь на Linux, без подмены глобалов. Адаптер в бою вызывает
 * currentPathContext() — он читает окружение В МОМЕНТ ВЫЗОВА (тесты подменяют
 * HOME и переменные между кейсами).
 *
 * ★ Правило для адаптеров: где лежит конфиг — только по первоисточнику
 * инструмента (дока или исходник), с URL и датой сверки в комментарии. До 0.4.5
 * у Pi стояла выдуманная переменная PI_HOME, а Zed и Hermes на Windows писали в
 * каталог, который инструмент не читает.
 */
import path from 'node:path';
import { homedir } from 'node:os';

/** Всё, от чего зависит путь к конфигу. */
export interface PathContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

/** Реальное окружение процесса на момент вызова. */
export function currentPathContext(): PathContext {
  return { platform: process.platform, env: process.env, home: homedir() };
}

/**
 * Функции пути ЦЕЛЕВОЙ платформы: для win32 — с обратной косой чертой, иначе
 * posix. На реальной машине совпадает с обычным `node:path`; различие видно
 * только в тестах, которые проверяют чужую платформу.
 */
export function pathApi(ctx: PathContext): path.PlatformPath {
  return ctx.platform === 'win32' ? path.win32 : path.posix;
}

/** Значение переменной окружения: без пробелов по краям, пустое — как отсутствие. */
export function envValue(ctx: PathContext, name: string): string | undefined {
  const value = ctx.env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Раскрывает ведущую `~` в домашний каталог. Оболочка делает это сама, но
 * переменная, заданная в `.env`-файле, systemd-юните или через `setx`,
 * приходит с тильдой как есть — а инструменты (Pi, Hermes) её раскрывают.
 */
export function expandTilde(value: string, ctx: PathContext): string {
  if (value === '~') return ctx.home;
  if (value.startsWith('~/') || (ctx.platform === 'win32' && value.startsWith('~\\'))) {
    return pathApi(ctx).join(ctx.home, value.slice(2));
  }
  return value;
}

/**
 * Базовые каталоги XDG — так же, как их считает npm-пакет `xdg-basedir`, на
 * котором стоят opencode и Kilo: переменная, иначе каталог в домашнем. Особого
 * случая для Windows и macOS там НЕТ — `~/.config` и `~/.local/share` всюду.
 */
export function xdgConfigHome(ctx: PathContext): string {
  return envValue(ctx, 'XDG_CONFIG_HOME') ?? pathApi(ctx).join(ctx.home, '.config');
}

export function xdgDataHome(ctx: PathContext): string {
  return envValue(ctx, 'XDG_DATA_HOME') ?? pathApi(ctx).join(ctx.home, '.local', 'share');
}
