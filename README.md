# @joingonka/setup

[![npm version](https://img.shields.io/npm/v/@joingonka/setup.svg)](https://www.npmjs.com/package/@joingonka/setup)
[![license](https://img.shields.io/npm/l/@joingonka/setup.svg)](./LICENSE)

**One command to point your AI coding agent at the cheapest decentralized AI API.**

`@joingonka/setup` configures 15 agentic AI tools — Claude Code, OpenClaw, Cursor, Cline, opencode, Aider, Kilo Code, Roo Code, Continue, Hermes, Pi, Zed, ZCode, JetBrains AI Assistant, and GitHub Copilot BYOK — to run on [JoinGonka Gateway](https://gate.joingonka.ai), an OpenAI- and Anthropic-compatible gateway for the decentralized [Gonka Network](https://gonka.ai). Inference runs on the network's own GPUs instead of a centralized provider, so flagship open models (Kimi K2.6, MiniMax M2.7, DeepSeek V4 Flash) cost roughly **100x less** than the usual cloud AI APIs — a genuinely cheap, affordable AI API for coding agents, with no metered per-seat subscription.

```bash
npx @joingonka/setup
```

That's it. The installer asks which tool to set up and for your API key (`jg-...`), backs up the existing config, writes only the fields it needs, and then makes a **live request to the gateway** to prove the key, URL, and model are actually accepted — no silent "successfully configured" that turns out broken on first use.

## Why

- **Cheapest flagship inference.** Decentralized GPUs + billing in GNK/USDT means a fraction of the price of centralized providers, while still serving large open models with native streaming and native tool calling.
- **One key, 15 tools.** Set up Claude Code today and Aider tomorrow with the same key and the same command, instead of a different installer per tool.
- **No subscription lock-in.** A usage-based, bring-your-own-key alternative for anyone who has hit a metered AI coding plan's limits.
- **Verified, not assumed.** Every run ends with a real inference call so a misconfigured endpoint fails loudly during setup, not mid-task.

## Supported tools

| Tool           | Method            | Where                                              |
|----------------|-------------------|----------------------------------------------------|
| Claude Code    | JSON              | `~/.claude/settings.json`                          |
| OpenClaw       | JSON              | `~/.openclaw/openclaw.json`                        |
| opencode       | JSON              | `opencode.json` + key in native `auth.json`        |
| Kilo Code      | JSON              | `~/.config/kilo/kilo.jsonc`                        |
| Pi             | JSON              | `~/.pi/agent/models.json` + default in `settings.json` |
| Zed            | JSONC             | `~/.config/zed/settings.json` (comments preserved; key via env/UI) |
| Hermes         | YAML              | `~/.hermes/config.yaml` (key in `model.api_key`)   |
| Aider          | env variables     | prints `OPENAI_API_BASE` / `OPENAI_API_KEY`        |
| Cursor         | instructions (UI) | prints the values to enter in Settings → Models    |
| Cline          | instructions (UI) | prints the values to enter in the UI               |
| Roo Code       | instructions (UI) | prints the values to enter in the UI               |
| Continue       | instructions      | YAML block for `~/.continue/config.yaml`           |
| ZCode          | instructions (UI) | prints the values for Settings → Model Settings    |
| JetBrains      | instructions (UI) | prints the values for AI Assistant providers       |
| Copilot BYOK   | instructions (UI) | prints the values for Settings → Model Providers   |

Seven tools get their config written and merged in place; the rest are GUI-only, so the installer prints exactly what to paste. Either way the run ends with a live request that proves the key, URL, and model work. Per-tool background lives in the setup guides at [joingonka.ai/en/knowledge](https://joingonka.ai/en/knowledge) — the gateway works with any client that accepts a custom OpenAI- or Anthropic-compatible base URL.

## Usage

Interactive (recommended):

```bash
npx @joingonka/setup
```

The installer prompts for the tool and the API key (`jg-...`), backs up any existing config, and merges in only the fields it needs, leaving your other settings untouched.

Non-interactive (the key is read from an environment variable, never a CLI argument):

```bash
JOINGONKA_API_KEY=jg-your-key npx @joingonka/setup --tool openclaw --non-interactive
```

## Options

- `--tool <claude-code|openclaw|cursor|cline|opencode|aider|kilo|roo|continue|hermes|pi|zed|zcode|jetbrains|copilot-byok>` — which tool to configure (omit to choose interactively).
- `--scope <user|local>` — globally (`user`, default) or in the current project (`local`).
- `--model <id|kimi|deepseek>` — model: defaults to MiniMax-M2.7, `kimi` selects Kimi K2.6, `deepseek` selects DeepSeek V4 Flash (380K context), or pass an explicit model id.
- `--non-interactive` — no prompts; the key is taken from `JOINGONKA_API_KEY`.
- `--no-verify` — skip the live check after configuration.

## Get an API key

Register at [gate.joingonka.ai/register](https://gate.joingonka.ai/register), get free credits to test, and copy your key (`jg-...`) from the Dashboard.

## Security

The API key is never accepted as a command-line argument (it would leak into shell history and the process list). Only the password prompt or the `JOINGONKA_API_KEY` environment variable. Tool config files that store the key are written with `600` permissions.

## Links

- [JoinGonka Gateway](https://gate.joingonka.ai) — dashboard, keys, billing, usage.
- [Live status](https://gate.joingonka.ai/status) — gateway and model availability.
- [Integration guides](https://joingonka.ai/en/knowledge) — per-tool setup for every supported client.
- [Awesome JoinGonka](https://github.com/unameisfine/awesome-joingonka) — SDKs, frameworks, and agents that run on the gateway.

## License

Apache-2.0
