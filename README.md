# @joingonka/setup

Установщик «в одну команду», настраивающий агентные AI-инструменты на [JoinGonka Gateway](https://gate.joingonka.ai) — децентрализованный AI-инференс сети Gonka.

Поддерживаемые инструменты:

| Инструмент   | Способ               | Куда                                            |
|--------------|----------------------|-------------------------------------------------|
| Claude Code  | JSON                 | `~/.claude/settings.json`                       |
| OpenClaw     | JSON                 | `~/.openclaw/openclaw.json`                      |
| opencode     | JSON                 | `~/.config/opencode/opencode.json`              |
| Kilo Code    | JSON                 | `~/.config/kilo/kilo.jsonc`                      |
| Aider        | env-переменные       | инструкции (`OPENAI_API_BASE`/`OPENAI_API_KEY`) |
| Cline        | инструкции (UI)      | выводит значения для ввода в UI                  |
| Roo Code     | инструкции (UI)      | выводит значения для ввода в UI                  |
| Continue.dev | инструкции (YAML)    | YAML-блок для `~/.continue/config.yaml`         |

После настройки установщик делает **live-проверку** — реальный запрос к gateway, чтобы убедиться, что ключ, URL и модель приняты (а не «успешно настроено», которое на деле не работает).

## Использование

Интерактивно:

```bash
npx @joingonka/setup
```

Установщик спросит инструмент и API-ключ (`jg-...`), сделает бэкап существующего конфига и аккуратно допишет только нужные поля, сохранив ваши настройки.

Неинтерактивно (ключ — только через переменную окружения, никогда аргументом):

```bash
JOINGONKA_API_KEY=jg-your-key npx @joingonka/setup --tool openclaw --non-interactive
```

## Опции

- `--tool <claude-code|openclaw|cline|opencode|aider|kilo|roo|continue>` — какой инструмент настроить (без флага спросит интерактивно).
- `--scope <user|local>` — глобально (`user`, по умолчанию) или в текущем проекте (`local`).
- `--model <id|kimi>` — модель: по умолчанию Qwen3-235B, `kimi` → Kimi K2.6, либо явный id модели.
- `--non-interactive` — без промптов; ключ берётся из `JOINGONKA_API_KEY`.
- `--no-verify` — пропустить live-проверку после настройки.

## Где взять ключ

Зарегистрируйтесь на [gate.joingonka.ai/register](https://gate.joingonka.ai/register), получите бесплатные токены на тест и скопируйте ключ (`jg-...`) из Dashboard.

## Безопасность

API-ключ не принимается аргументом командной строки (он попал бы в историю shell и в список процессов). Только password-промпт или переменная окружения `JOINGONKA_API_KEY`.

## Лицензия

Apache-2.0
