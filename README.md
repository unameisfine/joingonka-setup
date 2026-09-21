# @joingonka/setup

[![npm version](https://img.shields.io/npm/v/@joingonka/setup.svg)](https://www.npmjs.com/package/@joingonka/setup)
[![license](https://img.shields.io/npm/l/@joingonka/setup.svg)](./LICENSE)

**One command to point your AI coding agent at the cheapest decentralized AI API.**

`@joingonka/setup` configures 25 agentic AI tools — Claude Code, Codex CLI, opencode, OpenClaw, Hermes, Pi, omp (Oh My Pi), Cursor, Cline, Kilo Code, Goose, Crush, Qwen Code, Kimi Code, Factory Droid, Zed, Aider, GitHub Copilot BYOK, JetBrains AI Assistant, Zoo Code, MiMo Code, MiniMax Code, ZCode, Continue, and Roo Code — to run on [JoinGonka Gateway](https://gate.joingonka.ai), an OpenAI- and Anthropic-compatible gateway for the decentralized [Gonka Network](https://gonka.ai). Inference runs on the network's own GPUs instead of a centralized provider, so flagship open models (MiniMax M2.7, DeepSeek V4 Flash, GLM 5.3 Flash) cost roughly **100x less** than the usual cloud AI APIs — a genuinely cheap, affordable AI API for coding agents, with no metered per-seat subscription.

```bash
npx @joingonka/setup
```

That's it. The installer asks which tool to set up and for your API key (`jg-...`), backs up the existing config, writes only the fields it needs, and then makes a **live request to the gateway** to prove the key, URL, and model are actually accepted — no silent "successfully configured" that turns out broken on first use.

## Why

- **Cheapest flagship inference.** Decentralized GPUs + billing in GNK/USDT means a fraction of the price of centralized providers, while still serving large open models with native streaming and native tool calling.
- **One key, 25 tools.** Set up Claude Code today and Codex CLI tomorrow with the same key and the same command, instead of a different installer per tool.
- **No subscription lock-in.** A usage-based, bring-your-own-key alternative for anyone who has hit a metered AI coding plan's limits.
- **Verified, not assumed.** Every run ends with a real inference call so a misconfigured endpoint fails loudly during setup, not mid-task.

## Supported tools

| Tool | `--tool` | Method | What is written, and where | API key | Default model |
|------|----------|--------|----------------------------|---------|---------------|
| Claude Code | `claude-code` | JSON | `~/.claude/settings.json` (`--scope local`: `.claude/settings.local.json`) — URL, model, context window | in the file, `600` | DeepSeek V4 Flash |
| Codex CLI | `codex` | TOML | `~/.codex/config.toml` (`CODEX_HOME` honoured) — `[model_providers.joingonka]` over the Responses API, plus `model`, `model_provider`, `model_context_window` | in the file as `experimental_bearer_token`, `600` — see [Codex CLI](#codex-cli) | DeepSeek V4 Flash |
| opencode | `opencode` | JSON | `opencode.json`, or the existing global config opencode loads last — see [opencode and Kilo Code](#opencode-and-kilo-code) (`XDG_CONFIG_HOME` / `XDG_DATA_HOME` honoured) | native `auth.json`, `600` | DeepSeek V4 Flash |
| OpenClaw | `openclaw` | JSON | `~/.openclaw/openclaw.json` — provider, primary model and fallbacks | in the file, `600` | DeepSeek V4 Flash |
| Hermes | `hermes` | YAML | `~/.hermes/config.yaml`, `%LOCALAPPDATA%\hermes\config.yaml` on Windows | in the file (`model.api_key`), `600` | DeepSeek V4 Flash |
| Pi | `pi` | JSON | `~/.pi/agent/models.json` + default in `settings.json` (`PI_CODING_AGENT_DIR` honoured) | in the file, `600` | DeepSeek V4 Flash |
| omp (Oh My Pi) | `omp` | YAML | `~/.omp/agent/models.yml` + `modelRoles.default` in `config.yml` (`PI_CODING_AGENT_DIR`, `OMP_PROFILE` honoured) | in `models.yml`, `600` | DeepSeek V4 Flash |
| Cursor | `cursor` | instructions (UI) | prints the values to enter in Settings → Models | you paste it | MiniMax M2.7 |
| Cline | `cline` | instructions (UI) | prints the values to enter in the UI, incl. model limits | you paste it | MiniMax M2.7 |
| Kilo Code | `kilo` | JSONC | `~/.config/kilo/kilo.jsonc`, or the existing global config Kilo loads last — see [opencode and Kilo Code](#opencode-and-kilo-code) (`XDG_CONFIG_HOME` honoured) | in the file, `600` | DeepSeek V4 Flash |
| Goose | `goose` | JSON + YAML | `~/.config/goose/custom_providers/custom_joingonka.json` + default provider and model in `config.yaml` (`%APPDATA%\Block\goose\config` on Windows; `GOOSE_PATH_ROOT` honoured) | `secrets.yaml` (`600`) or one `goose configure` step — see [Goose](#goose) | DeepSeek V4 Flash |
| Crush | `crush` | JSON | `~/.config/crush/crush.json` (`CRUSH_GLOBAL_CONFIG` honoured) — provider, models with prices, `models.large` / `models.small` | in the file, `600` | DeepSeek V4 Flash (small model: MiniMax M2.7) |
| Qwen Code | `qwen-code` | JSON | `~/.qwen/settings.json` (`QWEN_HOME` honoured) — `modelProviders.openai`, `security.auth.selectedType`, `model` | in the file's own `env` block, `600` | DeepSeek V4 Flash |
| Kimi Code CLI | `kimi-code` | TOML | `~/.kimi-code/config.toml` (`KIMI_CODE_HOME` honoured) — `[providers.joingonka]`, a `[models."joingonka/…"]` table per model, `default_model` | in the file (`api_key`), `600` | DeepSeek V4 Flash |
| Factory Droid | `droid` | JSON | `~/.factory/settings.json` — `customModels[]`, `sessionDefaultSettings.model` | in the file (each custom model entry), `600` | DeepSeek V4 Flash |
| Zed | `zed` | JSONC | `~/.config/zed/settings.json`, `%APPDATA%\Zed\settings.json` on Windows (comments preserved) | **not** in the file — Zed keychain or an environment variable, printed per platform | MiniMax M2.7 (you pick it in the Agent Panel) |
| Aider | `aider` | instructions | prints a `.aider.conf.yml` block (env exports only as a one-off alternative) | you paste it | MiniMax M2.7 |
| Copilot BYOK | `copilot-byok` | instructions | three sections — VS Code, Copilot CLI, JetBrains — see [GitHub Copilot BYOK](#github-copilot-byok) | you paste it | MiniMax M2.7 |
| JetBrains | `jetbrains` | instructions (UI) | prints the values for AI Assistant providers | you paste it | MiniMax M2.7 |
| Zoo Code | `zoo` | instructions (UI) | the community successor of Roo Code: prints the values for API Provider → OpenAI Compatible and the model limits for Model Configuration | you paste it | MiniMax M2.7 |
| MiMo Code | `mimo-code` | JSONC | `~/.config/mimocode/mimocode.jsonc`, or the existing global config MiMo Code writes to itself (`MIMOCODE_HOME`, `XDG_*` honoured) | native `auth.json`, `600` | DeepSeek V4 Flash |
| MiniMax Code | `minimax-code` | YAML | `~/.minimax/config.yaml` (`MINIMAX_DATA_DIR` honoured) — `custom_provider.joingonka`, `defaultModel` | in the file, `600` | DeepSeek V4 Flash |
| ZCode | `zcode` | instructions (UI) | prints the values for Settings → Model Settings | you paste it | MiniMax M2.7 |
| Continue | `continue` | instructions | full YAML for `~/.continue/config.yaml` (Continue is no longer maintained) | you paste it | MiniMax M2.7 |
| Roo Code | `roo` | instructions (UI) | **shut down on May 15, 2026** — prints the notice and where to go (`--tool zoo`, `--tool cline`, `--tool kilo`) first, then the old values | you paste it | MiniMax M2.7 |

16 tools get their config written and merged in place; for the other 9 — GUI-only tools and tools that keep the key in a store the installer cannot reach — it prints exactly what to enter, including the real context window and max output of the chosen model, because the tools' own defaults for a custom model match none of them. Either way the run ends with a live request that proves the key, URL, and model work. Per-tool background lives in the setup guides at [joingonka.ai/en/knowledge](https://joingonka.ai/en/knowledge) — the gateway works with any client that accepts a custom OpenAI- or Anthropic-compatible base URL.

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

- `--tool <claude-code|codex|opencode|openclaw|hermes|pi|omp|cursor|cline|kilo|goose|crush|qwen-code|kimi-code|droid|zed|aider|copilot-byok|jetbrains|zoo|mimo-code|minimax-code|zcode|continue|roo>` — which tool to configure (omit to choose interactively; `--help` prints the same list).
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

- **DeepSeek V4 Flash** where the installer writes the model into the config — Claude Code, Codex CLI, opencode, OpenClaw, Hermes, Pi, omp, Kilo Code, Goose, Crush, Qwen Code, Kimi Code, Factory Droid, MiMo Code and MiniMax Code. Coding agents run long tool-calling sessions, so the long context and the 32K output ceiling matter most. The live check at the end of the run is made with that same model.
- **MiniMax M2.7** in the printed instructions (Cursor, Cline, Aider, Copilot BYOK, JetBrains, Zoo Code, ZCode, Continue, Roo) and for Zed, where the installer writes the provider but you pick the model in the Agent Panel — MiniMax has the most capacity on the network.

Details worth knowing:

- An existing choice is respected where a tool can hold several providers (every tool with a written config except Claude Code and Hermes): if the config already points at another provider or at a current Gonka model, a plain re-run leaves the default alone and tells you how to switch. Two deliberate exceptions — a Codex config that selects no provider at all, and a Qwen Code setup still on the discontinued `qwen-oauth` tier — are explained under [Tool notes](#tool-notes). Claude Code and Hermes have a single model slot, so it is set on every run. An explicit `--model` is always written — and the installer makes sure it takes effect, even where the tool keeps its choice in another file (see [Tool notes](#tool-notes)).
- **OpenClaw** gets a primary model plus fallbacks (`agents.defaults.model.fallbacks`: GLM, then MiniMax), so a busy model switches the agent over instead of failing it. Your own fallback list is kept — only retired Gonka models are dropped from it.
- **Claude Code** gets the model pinned (`ANTHROPIC_MODEL` and the `opus` / `sonnet` aliases; `haiku`, used for background tasks, goes to MiniMax) and its real limits declared (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`). Without them Claude Code assumes its own window and stops compacting in time.
- Models that left the network (`kimi`, `glm-5.2`, `qwen`) are refused **before anything is written**, and so is an unknown shortcut (usually a typo). A full `vendor/model` id the installer does not know is written as given, with a warning — the network may get a model before the installer learns about it.
- Re-running the installer also cleans up after retired models: besides refreshing its own model catalog it repoints or removes references to them in fallbacks, per-agent models and `small_model`. References to other providers are never touched.

## Tool notes

### Codex CLI

Codex talks to the gateway over the Responses API (`wire_api = "responses"`, the only protocol Codex supports). Its provider table has three ways to get a key: `env_key` (the *name* of an environment variable), `auth` (a command that prints a token) and `experimental_bearer_token` (the value itself). Only the last one can hold the key literally, so that is where the installer writes it, in a file set to `600`. Be aware of what that means: Codex marks the field experimental and its docs discourage it in favour of `env_key`. It exists in the current release and in `main`, but it may be renamed without notice — requests would then fail with 401, and re-running a newer installer fixes it. An `env_key` line in our table is removed (Codex reads it first and fails when the variable is missing); a table that uses an `auth` command is left alone and no key is stored. If your `config.toml` selected no provider, Codex now starts with JoinGonka and the installer prints how to go back; if it selected another one, that default is kept and you get a one-off command instead (`codex -c model_provider=joingonka -m …`). The Codex IDE extension reads the same file.

### Goose

Goose's provider file holds only the *name* of the secret (`CUSTOM_JOINGONKA_API_KEY`), never its value. Goose looks the value up in the environment, then in the system keyring, and reads `secrets.yaml` only when its secret store is file-based. So the key is written to `secrets.yaml` (`600`, other secrets untouched) only when that is clearly the case — `GOOSE_DISABLE_KEYRING` is set (in the environment or in `config.yaml`) or `secrets.yaml` already exists. Otherwise the installer cannot write the keyring, will not switch it off for you (Goose would stop seeing the secrets already in it), and says so plainly: one step is left — `goose configure` → Configure Providers → JoinGonka → paste the key.

### Crush

Crush stores the model you last picked in its UI in a *state* file (`~/.local/share/crush/crush.json`), and that file overrides `crush.json`. Without `--model` the installer leaves it alone and tells you which model Crush will really start with. With an explicit `--model`, when that state file (or a `model large …` line in `crushrc`) would override it, the installer edits one key of the state file — `models.large` — because otherwise the flag would silently do nothing; the message says what was changed and where the backup is. A `crushrc` shell config is never edited. Crush only accepts strict JSON, so the installer warns if your `crush.json` has comments.

### Qwen Code

The free `qwen-oauth` tier was discontinued on April 15, 2026, and Qwen Code falls back to it when no auth type is selected. So with `security.auth.selectedType` unset or set to `qwen-oauth` the installer switches it to `openai` and makes a JoinGonka model the default, and the message says what was replaced and how to go back. Any other auth type (`anthropic`, `gemini`, `vertex-ai`) is a working choice and is kept unless you pass `--model`. The key lives in the `env` block of `settings.json` — the place Qwen Code's own `/auth` uses — not in your shell profile.

### opencode and Kilo Code

Both tools read several global config files and merge them; a later file overrides an earlier one. opencode loads `config.json` → `opencode.json` → `opencode.jsonc` (and creates `opencode.jsonc` itself on first start), Kilo Code loads `config.json` → `kilo.json` → `kilo.jsonc` → `opencode.json` → `opencode.jsonc`. The installer writes into the existing file that is loaded last, so that what it writes — an explicit `--model` above all — really takes effect; with no config yet it creates `opencode.json` / `kilo.jsonc`. A model chosen in a lower-priority file is your choice and is kept. If an earlier installer version left its provider block in a lower-priority file, that block is refreshed there too (with a backup): the tools merge model catalogs, so retired models would otherwise come back from the old file. Files with nothing of ours in them are not touched.

### GitHub Copilot BYOK

Copilot keeps the key in each client's own store, so nothing is written; `--tool copilot-byok` prints three sections. **VS Code** — the Custom Endpoint provider (works without a GitHub account or a Copilot plan) with a ready-to-paste `"models"` array carrying the real limits. **Copilot CLI** — the `COPILOT_PROVIDER_*` environment variables for the current shell. **JetBrains** — the values for Manage Models → Add Models.

### Zed

Zed does not read keys from `settings.json`, so the installer writes the provider and the model catalog and prints how to hand over the key: Zed's own key store, or an environment variable — `export` on Linux and macOS, `$env:` (current window) and `setx` (permanent) in PowerShell on Windows.

## What the live check means

Every run ends with a real one-token request made with your key, the base URL and the model (skip it with `--no-verify`):

- **`✓ Verified`** — the gateway answered 200.
- **`✗ Verification FAILED`, exit code 2** — a configuration problem: the key, the model id or the URL was rejected (401, 403, 400, 404 …). The config was written, but it will not work until that is fixed.
- **`! Could not verify right now`, exit code 0** — the config is fine, the network is not: rate limiting or overload (429), a 5xx or a timeout (each retried, three attempts in total), or an empty balance (402 — the key works, top up first). Check [the status page](https://gate.joingonka.ai/status).

Exit code 1 means the setup itself stopped — an unknown tool or model, a config file that cannot be parsed, a missing key — and the message says why.

## Your config stays yours

- Files are read as what they are — JSON with comments and trailing commas, YAML, TOML — and edited in place: only the installer's own keys change; other providers, MCP servers, themes, comments and formatting stay as they were.
- A file that cannot be parsed is **not** replaced by a fresh one. The installer stops, writes nothing and tells you the file and the line. The same goes for a key that holds something unexpected where the installer has to add its settings (say, `"provider": "x"`): your value is not overwritten. A refused run leaves nothing behind — not even a backup file.
- When the write does happen, a timestamped `.bak` copy of the previous file is made first.
- For OpenClaw, Pi, omp and Crush the per-token prices shown in the tool's UI are taken live from the gateway at install time (the USD price floats with GNK); if the gateway cannot be reached, built-in values are used.

## Get an API key

Register at [gate.joingonka.ai/register](https://gate.joingonka.ai/register), get free credits to test, and copy your key (`jg-...`) from the Dashboard.

## Security

The API key is never accepted as a command-line argument (it would leak into shell history and the process list). Only the password prompt or the `JOINGONKA_API_KEY` environment variable.

The key is written literally into the tool's own config — no `${ENV}` references, which break as soon as the tool starts without that variable — and every file that holds it is set to `600` (owner-only), including Claude Code's `settings.json`. Global `OPENAI_*` / `ANTHROPIC_*` variables are never touched, so your other tools keep working. With `--scope local` the installer adds `.claude/settings.local.json` to the project's `.gitignore`, so the key does not end up in a commit. Two tools keep the key out of their config by design, and the installer follows them: Zed does not read keys from `settings.json`, and Goose keeps provider keys in the system keyring (see [Tool notes](#tool-notes)). For both the installer prints the one remaining step instead of inventing a place for the key.

## Links

- [JoinGonka Gateway](https://gate.joingonka.ai) — dashboard, keys, billing, usage.
- [Live status](https://gate.joingonka.ai/status) — gateway and model availability.
- [Integration guides](https://joingonka.ai/en/knowledge) — per-tool setup for every supported client.
- [Awesome JoinGonka](https://github.com/unameisfine/awesome-joingonka) — SDKs, frameworks, and agents that run on the gateway.

## License

Apache-2.0
