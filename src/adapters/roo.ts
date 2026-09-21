/**
 * Адаптер Roo Code (https://roocode.com) — instructions-only, ПРОДУКТ ЗАКРЫТ.
 *
 * ★ Расширение Roo Code закрыто 15 мая 2026. Сверено 21.09.2026 по первоисточнику
 * — https://github.com/RooCodeInc/Roo-Code: README, раздел «Disclaimer» («The Roo
 * Code Extension was shut down on May 15th»), репозиторий переведён в архив
 * (GitHub API: archived=true), последний релиз v3.54.0 от 15.05.2026. Там же
 * названы альтернативы: ZooCode («a fork started by the Roo Code community») и
 * Cline («from where Roo Code originated»). Kilo Code добавляем от себя — ещё
 * один открытый кодовый агент, который ставит этот установщик (README Roo его не
 * называет, поэтому и в тексте не выдаём его за рекомендацию Roo).
 *
 * Поэтому `--tool roo` СНАЧАЛА говорит о закрытии и о том, куда идти, и лишь
 * затем печатает прежнюю инструкцию: у части людей расширение ещё установлено и
 * работает, отнимать у них рабочие значения незачем. Молча печатать инструкцию к
 * закрытому продукту — хуже: человек поставит то, что уже не обновляется.
 *
 * Roo (VS Code, форк Cline) настраивается в UI расширения. Рабочие настройки
 * живут в зашифрованном SecretStorage VS Code — безопасного плоского файла для
 * записи нет, поэтому адаптер возвращает значения для ручного ввода (как Cline).
 *
 * Значения — вариант «OpenAI Compatible»:
 *   API Provider: OpenAI Compatible
 *   Base URL:     BASE_URL_OPENAI (С /v1)
 *   API Key:      <jg-ключ>
 *   Model:        <точный id, как отдаёт /v1/models>
 *
 * NB: у Roo есть авто-импорт через VS Code setting `roo-cline.autoImportSettingsPath`
 * + JSON-профиль, но он требует записать jg-ключ в файл на диск — мы этого избегаем
 * (instructions-only безопаснее). Roo требует НАТИВНЫЙ tool-calling у модели (есть
 * у наших MiniMax/DeepSeek/GLM).
 */
import { BASE_URL_OPENAI, formatModelLimits } from '../constants.js';
import type { Adapter, ApplyInput, ApplyResult, Scope } from './types.js';

function resolvePath(_scope: Scope): string | null {
  return null;
}

async function apply(input: ApplyInput): Promise<ApplyResult> {
  // Куда отправить человека: команда установщика, если инструмент в нём ЕСТЬ,
  // иначе адрес проекта. Совет «запусти --tool zoo», который кончается ошибкой
  // «Unknown tool», хуже отсутствия совета, а состав реестра меняется отдельно от
  // этого файла. Реестр грузим лениво: он сам импортирует этот модуль, и
  // статический импорт замкнул бы цикл.
  const { getAdapter } = await import('./registry.js');
  const goTo = (id: string, url: string) => (getAdapter(id) ? `--tool ${id}` : url);

  return {
    configPath: null,
    backupPath: null,
    wrote: false,
    messages: [
      'NOTE: the Roo Code extension was shut down on May 15, 2026 — its repository is',
      'archived and it gets no more updates. Consider moving to one of these instead:',
      `  Zoo Code  — the fork started by the Roo Code community:  ${goTo('zoo', 'https://github.com/Zoo-Code-Org/Zoo-Code')}`,
      `  Cline     — the project Roo Code was forked from:        ${goTo('cline', 'https://cline.bot')}`,
      `  Kilo Code — another open-source coding agent:            ${goTo('kilo', 'https://kilo.ai')}`,
      '',
      'If you still have Roo Code installed, it is configured in the VS Code extension',
      'UI (no file is written). Open the Roo settings (gear icon) → API Provider, then enter:',
      '',
      '  API Provider: OpenAI Compatible',
      `  Base URL:     ${BASE_URL_OPENAI}`,
      `  API Key:      ${input.apiKey}`,
      `  Model:        ${input.model}`,
      '',
      formatModelLimits(input.model),
      'Roo needs native tool-calling — all our Gonka models support it.',
    ],
  };
}

export const rooAdapter: Adapter = {
  id: 'roo',
  // Пометка в меню выбора: человек должен увидеть статус ДО того, как выберет.
  // В реестре Roo стоит последним — после всех живых инструментов.
  label: 'Roo Code (discontinued — shut down May 2026; see Zoo Code / Kilo / Cline)',
  format: 'instructions',
  apiMode: 'openai',
  resolvePath,
  apply,
};
