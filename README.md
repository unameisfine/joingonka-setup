# @joingonka/setup

[![npm version](https://img.shields.io/npm/v/@joingonka/setup.svg)](https://www.npmjs.com/package/@joingonka/setup)
[![license](https://img.shields.io/npm/l/@joingonka/setup.svg)](./LICENSE)

**One command to point your AI coding agent at the cheapest decentralized AI API.**

`@joingonka/setup` configures 15 agentic AI tools — Claude Code, OpenClaw, Cursor, Cline, opencode, Aider, Kilo Code, Roo Code, Continue, Hermes, Pi, Zed, ZCode, JetBrains AI Assistant, and GitHub Copilot BYOK — to run on [JoinGonka Gateway](https://gate.joingonka.ai), an OpenAI- and Anthropic-compatible gateway for the decentralized [Gonka Network](https://gonka.ai). Inference runs on the network's own GPUs instead of a centralized provider, so flagship open models (MiniMax M2.7, DeepSeek V4 Flash, GLM 5.3 Flash) cost roughly **100x less** than the usual cloud AI APIs — a genuinely cheap, affordable AI API for coding agents, with no metered per-seat subscription.

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
| Claude Code    | JSON              | `~/.claude/settings.json` (`--scope local`: `.claude/settings.local.json`) — key, URL, model, context window |
| OpenClaw       | JSON              | `~/.openclaw/openclaw.json` — provider, primary model and fallbacks |
| opencode       | JSON              | `opencode.json` + key in native `auth.json` (`XDG_CONFIG_HOME` / `XDG_DATA_HOME` honoured) |
| Kilo Code      | JSONC             | `~/.config/kilo/kilo.jsonc` (`XDG_CONFIG_HOME` honoured) |
| Pi             | JSON              | `~/.pi/agent/models.json` + default in `settings.json` (`PI_CODING_AGENT_DIR` honoured) |
| Zed            | JSONC             | `~/.config/zed/settings.json`, `%APPDATA%\Zed\settings.json` on Windows (comments preserved; key via env/UI) |
| Hermes         | YAML              | `~/.hermes/config.yaml`, `%LOCALAPPDATA%\hermes\config.yaml` on Windows (key in `model.api_key`) |
| Aider          | instructions      | prints a `.aider.conf.yml` block (env exports only as a one-off alternative) |
| Cursor         | instructions (UI) | prints the values to enter in Settings → Models    |
| Cline          | instructions (UI) | prints the values to enter in the UI, incl. model limits |
| Roo Code       | instructions (UI) | **shut down on May 15, 2026** — prints the notice and alternatives first, then the old values |
| Continue       | instructions      | full YAML for `~/.continue/config.yaml` (Continue is no longer maintained) |
| ZCode          | instructions (UI) | prints the values for Settings → Model Settings    |
| JetBrains      | instructions (UI) | prints the values for AI Assistant providers       |
| Copilot BYOK   | instructions (UI) | prints the values for Settings → Model Providers   |

Seven tools get their config written and merged in place; the rest are GUI-only, so the installer prints exactly what to paste — including the real context window and max output of the chosen model, because the tools' own defaults for a custom model match none of them. Either way the run ends with a live request that proves the key, URL, and model work. Per-tool background lives in the setup guides at [joingonka.ai/en/knowledge](https://joingonka.ai/en/knowledge) — the gateway works with any client that accepts a custom OpenAI- or Anthropic-compatible base URL.

## Usage

Interactive (recommended):

```bash
npx @joingonka/setup
```

The installer prompts for the tool and the API key (`jg-...`), backs up any existing config, and edits only the fields it needs, leaving your other settings — and your comments — untouched.

Non-interactive (the key is read from an environment variable, never a CLI argument):

```bash
JOINGONKA_API_KEY=jg-your-key npx @joingonka/setup --tool openclaw --non-interactive
```

## Options

- `--tool <claude-code|openclaw|cursor|cline|opencode|aider|kilo|roo|continue|hermes|pi|zed|zcode|jetbrains|copilot-byok>` — which tool to configure (omit to choose interactively).
- `--scope <user|local>` — `user` (default) writes the per-user config. `local` writes into the current project and is supported **only by Claude Code** (`.claude/settings.local.json`); every other tool keeps a single per-user config, so the installer refuses `--scope local` for them instead of quietly writing the global file.
- `--model <minimax|deepseek|glm|id>` — a shortcut or a full model id, see [Models](#models).
- `--non-interactive` — no prompts; the key is taken from `JOINGONKA_API_KEY`.
- `--no-verify` — skip the live check after configuration.

## Models

| Shortcut   | Model id                              | Context window | Max output |
|------------|---------------------------------------|----------------|------------|
| `minimax`  | `MiniMaxAI/MiniMax-M2.7`              | 200,000        | 8,192      |
| `deepseek` | `deepseek-ai/DeepSeek-V4-Flash-0731`  | 380,000        | 32,768     |
| `glm`      | `zai-org/GLM-5.3-Flash`               | 390,000        | 8,192      |

Without `--model` the default depends on what the installer does for the tool:

- **DeepSeek V4 Flash** where the installer writes the model into the config — Claude Code, OpenClaw, opencode, Kilo Code, Pi and Hermes. Coding agents run long tool-calling sessions, so the long context and the 32K output ceiling matter most.
- **MiniMax M2.7** in the printed instructions (Cursor, Cline, Continue, Aider, JetBrains, ZCode, Zed, Roo, Copilot BYOK) — there you pick the model by hand, and MiniMax has the most capacity on the network.

Details worth knowing:

- An existing choice is respected where a tool can hold several providers (OpenClaw, opencode, Kilo Code, Pi, Zed): if the config already points at another provider or at a current Gonka model, a plain re-run leaves the default alone. Claude Code and Hermes have a single model slot, so it is set on every run. An explicit `--model` is always written.
- **OpenClaw** gets a primary model plus fallbacks (`agents.defaults.model.fallbacks`: GLM, then MiniMax), so a busy model switches the agent over instead of failing it. Your own fallback list is kept — only retired Gonka models are dropped from it.
- **Claude Code** gets the model pinned (`ANTHROPIC_MODEL` and the `opus` / `sonnet` aliases; `haiku`, used for background tasks, goes to MiniMax) and its real limits declared (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`). Without them Claude Code assumes its own window and stops compacting in time.
- Models that left the network (`kimi`, `glm-5.2`, `qwen`) are refused **before anything is written**, and so is an unknown shortcut (usually a typo). A full `vendor/model` id the installer does not know is written as given, with a warning — the network may get a model before the installer learns about it.
- Re-running the installer also cleans up after retired models: besides refreshing its own model catalog it repoints or removes references to them in fallbacks, per-agent models and `small_model`. References to other providers are never touched.

## What the live check means

Every run ends with a real one-token request made with your key, the base URL and the model (skip it with `--no-verify`):

- **`✓ Verified`** — the gateway answered 200.
- **`✗ Verification FAILED`, exit code 2** — a configuration problem: the key, the model id or the URL was rejected (401, 403, 400, 404 …). The config was written, but it will not work until that is fixed.
- **`! Could not verify right now`, exit code 0** — the config is fine, the network is not: rate limiting or overload (429), a 5xx or a timeout (each retried, three attempts in total), or an empty balance (402 — the key works, top up first). Check [the status page](https://gate.joingonka.ai/status).

Exit code 1 means the setup itself stopped — an unknown tool or model, a config file that cannot be parsed, a missing key — and the message says why.

## Your config stays yours

- Files are read as what they are — JSON with comments and trailing commas, YAML — and edited in place: only the installer's own keys change; other providers, MCP servers, themes, comments and formatting stay as they were.
- A file that cannot be parsed is **not** replaced by a fresh one. The installer stops, writes nothing and tells you the file and the line. The same goes for a key that holds something unexpected where the installer has to add its settings (say, `"provider": "x"`): your value is not overwritten. A refused run leaves nothing behind — not even a backup file.
- When the write does happen, a timestamped `.bak` copy of the previous file is made first.
- For OpenClaw and Pi the per-token prices shown in the tool's UI are taken live from the gateway at install time (the USD price floats with GNK); if the gateway cannot be reached, built-in values are used.

## Get an API key

Register at [gate.joingonka.ai/register](https://gate.joingonka.ai/register), get free credits to test, and copy your key (`jg-...`) from the Dashboard.

## Security

The API key is never accepted as a command-line argument (it would leak into shell history and the process list). Only the password prompt or the `JOINGONKA_API_KEY` environment variable.

The key is written literally into the tool's own config — no `${ENV}` references, which break as soon as the tool starts without that variable — and every file that holds it is set to `600` (owner-only), including Claude Code's `settings.json`. Global `OPENAI_*` / `ANTHROPIC_*` variables are never touched, so your other tools keep working. With `--scope local` the installer adds `.claude/settings.local.json` to the project's `.gitignore`, so the key does not end up in a commit. Zed is the one exception: it does not read keys from `settings.json`, so the installer prints how to pass the key through Zed's keychain or an environment variable.

## Links

- [JoinGonka Gateway](https://gate.joingonka.ai) — dashboard, keys, billing, usage.
- [Live status](https://gate.joingonka.ai/status) — gateway and model availability.
- [Integration guides](https://joingonka.ai/en/knowledge) — per-tool setup for every supported client.
- [Awesome JoinGonka](https://github.com/unameisfine/awesome-joingonka) — SDKs, frameworks, and agents that run on the gateway.

## License

Apache-2.0
