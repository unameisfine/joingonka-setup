# Changelog

All notable changes to `@joingonka/setup` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates are npm publish dates (UTC).

## [0.5.0] - 2026-09-21

Ten more tools — 25 in total — and a round of fixes found while integrating them.

### Added

- **Codex CLI** (`--tool codex`) — `~/.codex/config.toml`: a `[model_providers.joingonka]`
  table over the Responses API, the default `model` / `model_provider` and the real
  `model_context_window`. The key is written literally as `experimental_bearer_token`
  (file mode `600`) — the only Codex setting that can hold one; Codex marks the field
  experimental, and the README says plainly what that means. The Codex IDE extension
  reads the same file.
- **Kimi Code CLI** (`--tool kimi-code`) — `~/.kimi-code/config.toml`: the provider with
  `api_key`, one `[models."joingonka/…"]` table per model with real limits and
  capabilities, `default_model`; references to retired models are cleaned up,
  `[secondary_model]` included.
- **omp / Oh My Pi** (`--tool omp`) — `~/.omp/agent/models.yml` plus `modelRoles.default`
  in `config.yml`, with live prices; omp's own `models.json` → `models.yml` and
  `settings.json` → `config.yml` migrations are not pre-empted.
- **MiniMax Code** (`--tool minimax-code`) — `~/.minimax/config.yaml`: a BYOK provider
  under `custom_provider`, exactly what `mcode provider add` writes.
- **Goose** (`--tool goose`) — a declarative provider in `custom_providers/` and the
  default provider and model in `config.yaml`. The key goes to `secrets.yaml` only
  when Goose uses its file-based secret store; otherwise the installer says that one
  `goose configure` step is left instead of switching your keyring off.
- **MiMo Code** (`--tool mimo-code`) — `mimocode.jsonc` plus the key in the native
  `auth.json`, the same two files the tool's own "Custom provider" wizard writes.
- **Qwen Code** (`--tool qwen-code`) — `~/.qwen/settings.json`: models in
  `modelProviders.openai`, the key in the file's own `env` block. A setup still on the
  discontinued `qwen-oauth` tier is switched to JoinGonka; any other working auth type
  is kept.
- **Factory Droid** (`--tool droid`) — `customModels` and `sessionDefaultSettings.model`
  in `~/.factory/settings.json`; other custom models and comments stay as they were.
- **Crush** (`--tool crush`) — provider, models with live prices and
  `models.large` / `models.small` in `crush.json`. Crush keeps the model picked in its
  UI in a state file that overrides `crush.json`: without `--model` the installer
  leaves it alone and tells you which model will really start; with an explicit
  `--model` it edits that one key, says so, and makes a backup.
- **Zoo Code** (`--tool zoo`) — the community successor of Roo Code; printed
  instructions with the real limits for its Model Configuration panel.
- TOML configs are edited in place like JSON and YAML ones: comments, table order and
  everything the installer does not own stay untouched, and the result is checked to
  differ from the original only where intended.

### Changed

- **opencode and Kilo Code: the installer writes into the file the tool actually
  obeys.** Both merge several global config files, and a later one wins — opencode
  even creates `opencode.jsonc` itself on first start, above the `opencode.json` the
  installer used to write. A `model` in the higher file silently overrode `--model`
  while the installer reported success. The installer now writes into the existing
  file that is loaded last (`opencode.json` / `kilo.jsonc` when there is none), keeps
  a model you chose in a lower-priority file, and refreshes — with a backup — a
  provider block that an earlier version left in a lower-priority file, so retired
  models do not come back from it. For Kilo Code an existing `kilo.json` is used
  instead of starting a second config next to it.
- **The live check verifies the model that was written.** For OpenClaw, opencode and
  Kilo Code the config got DeepSeek V4 Flash while the check was made with MiniMax
  M2.7, so `✓ Verified` could vouch for a model the tool would not use.
- **The live check speaks the tool's own protocol.** Codex CLI only talks to the
  Responses API, so `--tool codex` is now verified with a minimal stateless request
  to `/v1/responses` instead of `/v1/chat/completions`. The outcome is classified the
  same way: a rejected key, model or route fails the run, a busy network or an empty
  balance does not.
- **A model from outside the installer's catalog reaches the tool's model catalog
  everywhere.** `--model vendor/new-model` is accepted with a warning, because the
  network may get a model before the installer learns about it. The tools added in
  0.5.0 also put such a model into the provider's catalog; opencode, Kilo Code,
  OpenClaw, Pi, Zed, omp, MiniMax Code and Goose did not, so the default pointed at a
  model the tool could not find. All of them now add it, with conservative limits
  (200K context, 8,192 output). Unchanged, and now said in the warning: a later run
  *without* `--model` treats a model outside the catalog as retired and goes back to
  the default — keep passing the flag.
- **Zed on Windows** gets PowerShell instructions for the key (`$env:` for the
  current window, `setx` for a permanent variable) instead of a POSIX `export`.
  **Aider** and **Goose** print their one-session hints for PowerShell on Windows as
  well (Aider's says why `setx`, which Aider's own docs suggest, is a bad idea for
  `OPENAI_*`). The Windows locations of **omp** (`%USERPROFILE%\.omp\agent`) and
  **MiniMax Code** (`%USERPROFILE%\.minimax`) were checked against the tools'
  sources and are covered by tests.
- **Refusals always name the file.** Several adapters reported "The config file: …"
  without a path; the path is now required wherever a config is edited.
- **Hermes:** long lines you wrote yourself (a long prompt, a URL) are no longer
  re-wrapped at 80 columns when the installer saves `config.yaml`. A broken
  `config.yaml` is reported by error code and line, without quoting the file.
- The list of tools in `--help` and the "N tools supported" count come from the
  adapter registry instead of a hand-written copy, and the README and `package.json`
  are checked against it by the test suite. `--tool constructor` and similar names
  now give "Unknown tool" instead of a crash.
- The interactive menu lists the most used coding agents first; **Roo Code**, shut
  down in May 2026, is last and marked as discontinued, and its notice now points at
  `--tool zoo`.
- `CHANGELOG.md` ships in the npm package.
- `npm run typecheck` checks the types of the sources **and** of the tests (the build
  excludes tests, and the test runner does not check types); `npm publish` runs it
  before the build.

### Fixed

- **A live price is no longer overwritten by the built-in one.** OpenClaw, Pi, omp and
  Crush get per-token prices from the gateway at install time. When the gateway did
  not answer within three seconds, a re-run replaced the live price already in the
  config with the rougher built-in constant — so two runs in a row could leave
  different files. A price that is already recorded for a model is now left exactly
  as it is; the built-in value is used only for a model entry that is new. The one
  exception is the `0.07` / `0.1` constant written by versions up to 0.4.4: it was
  5–11 times too high and is still replaced.
- Running the installer twice with the same `--model` from outside the catalog no
  longer reports that it "cleaned up references to models that are no longer
  served" — the model had just been written by the installer itself.

## [0.4.5] - 2026-09-21

_Not published to npm on its own: it shipped as part of 0.5.0._

A safety release. An audit showed a class of defects where the installer could
silently damage a working setup: a config with a comment in it was replaced by a
fresh one, `--model` did not reach the tool, and Claude Code was never told the
real context window.

### Fixed

- **Your config is no longer overwritten.** OpenClaw, opencode, Kilo Code, Zed and
  Claude Code configs are JSONC/JSON5, but were read with `JSON.parse`; a comment
  or a trailing comma made the installer start from `{}` and write that over the
  file, taking MCP servers, other providers and settings with it. Configs are now
  read with a JSONC parser and edited in place, key by key, so comments,
  formatting and everything the installer does not own stay untouched.
- **A file that cannot be parsed stops the installer** — nothing is written and no
  backup is made — for every tool that writes a config, now including Hermes
  (`config.yaml`, broken YAML or a non-mapping root) and Pi (`models.json` and
  `settings.json`, both checked before the first write). The message names the
  file and the line.
- **So does a config with an unexpected shape.** Where the installer has to add
  its settings inside an object and finds something else there (`"provider": "x"`,
  `"env": 5`), it used to fail with a raw parser error. It now names the file and
  the key, says that nothing was written, and leaves your value alone.
- **A refused run leaves no stray `.bak`.** The new content is computed first and
  the backup is made only when the write is certain to follow; opencode and Pi,
  which write two files, compute both before touching either.
- **An edit that would corrupt the file is never written.** The edited text is
  parsed again before the write. This guards against a defect in the JSONC
  library, which garbles a single-line array when its last item is removed; the
  installer now replaces such arrays as a whole.
- **Claude Code gets the model and the real limits.** Without `ANTHROPIC_MODEL`
  the client sent its own `claude-*` id, which the gateway replaced with the first
  model of the network, and Claude Code assumed its own context window and did
  not compact in time. The installer now writes `ANTHROPIC_MODEL`, the model
  aliases, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS`;
  the file is set to `600`, and with `--scope local` it is added to `.gitignore`.
- **`--model` is actually applied** to OpenClaw, opencode, Kilo Code, Zed and
  Claude Code — before, the live check happily verified a model that was not in
  the config.
- **Hermes:** the model is written to `model.default`, the key Hermes reads first;
  stale aliases and env-based key fields are removed.
- **OpenClaw:** a config whose `agents.defaults.model` is a plain string (a form
  OpenClaw documents) no longer crashes the installer.
- **Config locations now match what the tools read:** Zed on Windows
  (`%APPDATA%\Zed\settings.json`) and on macOS (where Zed ignores
  `XDG_CONFIG_HOME`); Hermes on Windows (`%LOCALAPPDATA%\hermes`); Pi honours
  `PI_CODING_AGENT_DIR` instead of a `PI_HOME` variable Pi never had; opencode
  and Kilo Code honour `XDG_CONFIG_HOME` / `XDG_DATA_HOME`.
- **The live check tells a broken setup from a busy network.** 429, 5xx and
  timeouts are retried and end as a warning with exit code 0; an empty balance
  (402) is reported as such; only a rejected key, model or URL fails with exit
  code 2.
- **`--scope local` is refused for tools without a project config** instead of
  quietly writing the global file. Only Claude Code supports it.
- **Prices shown by OpenClaw and Pi** were 5–11 times too high. They are now taken
  live from the gateway at install time, with corrected built-in values as the
  fallback.
- Pi no longer replaces a model you picked yourself on every re-run.
- Instructions corrected against the vendors' own docs: Cline (no "Verify" button
  exists — the model limits are given instead), Cursor (the "requires a Pro plan"
  claim is gone; the documented limitations are stated), JetBrains (the "Tool
  calling" switch, the context window), ZCode (the enable switch, the Advanced
  panel), Continue (a new `config.yaml` needs `name`, `version` and `schema`).

### Added

- `--model minimax|deepseek|glm` shortcuts with case-insensitive model ids. Models
  that left the network (`kimi`, `glm-5.2`, `qwen`) and unknown shortcuts are
  refused before anything is written.
- References to retired models are cleaned up outside the installer's own model
  catalog too: OpenClaw fallbacks and per-agent models, `small_model` and
  agent/command models in opencode and Kilo Code, agent models in Zed, fallback
  entries in Hermes. References to other providers are never touched.
- OpenClaw gets fallback models (GLM, then MiniMax) unless you have your own.
- Printed instructions include the real context window and max output of the
  chosen model (Cline, Cursor, JetBrains, ZCode, Continue, Aider, Roo Code).
- `npm publish` is refused from a working tree with uncommitted or untracked
  files, and runs the test suite first.

### Changed

- The default model is **DeepSeek V4 Flash** where the installer writes the model
  into the config (Claude Code, OpenClaw, opencode, Kilo Code, Pi, Hermes).
  Printed instructions keep suggesting MiniMax M2.7.
- **Roo Code** was shut down on May 15, 2026. `--tool roo` now opens with that
  notice and the alternatives, then prints the previous values for those who
  still have the extension installed. **Continue** instructions note that the
  project was acquired by Cursor and is no longer maintained.

## [0.4.4] - 2026-09-16

### Changed

- GLM 5.3 Flash (390K context, 8,192 max output) replaces Kimi K2.6, which left
  the network; `--model glm` selects it.

### Fixed

- `--version` is read from `package.json` instead of a literal that had drifted.

## [0.4.3] - 2026-08-24

### Fixed

- Continue: the model block declares `capabilities: [tool_use]`. Without it
  Continue does not give Gonka models any tools, so Agent mode did not work.

## [0.4.2] - 2026-08-23

### Changed

- Hermes defaults to DeepSeek V4 Flash: an autonomous agent needs the long
  context and the 32K output ceiling. Adapters can now declare their own default
  model.

## [0.4.1] - 2026-08-20

### Fixed

- DeepSeek V4 Flash max output is 32,768 tokens, not the 8,192 shared by the other
  models — every adapter was writing a truncated limit.

## [0.4.0] - 2026-08-20

### Added

- Six more tools: Pi and Zed (config written), Cursor, ZCode, JetBrains AI
  Assistant and GitHub Copilot BYOK (printed instructions).

## [0.3.0] - 2026-08-20

### Added

- Hermes Agent — the first YAML adapter; comments in `config.yaml` are preserved
  and the key goes to `model.api_key`.

## [0.2.9] - 2026-08-13

### Added

- DeepSeek V4 Flash (380K context) and the `--model deepseek` shortcut.

## [0.2.8] - 2026-06-28

### Fixed

- Model limits raised to the real 200K context / 8,192 max output (they were
  understated as 131K / 3K–4K).

## [0.2.7] - 2026-06-28

### Changed

- Per-tool default model is MiniMax M2.7 instead of Kimi; unused env-reference
  constants removed.

## [0.2.6] - 2026-06-28

### Fixed

- OpenClaw and Kilo Code: the API key is written literally instead of as an
  environment reference, which failed whenever the variable was not exported.

## [0.2.5] - 2026-06-28

### Fixed

- Re-running the installer removes models that are no longer served instead of
  keeping them in the tool's catalog.

## [0.2.4] - 2026-06-27

### Removed

- Qwen3-235B, which is no longer on the network; MiniMax M2.7 becomes the default.

## [0.2.3] - 2026-06-25

### Fixed

- Adapter formats re-checked against the tools' own documentation and sources
  (OpenClaw, Cline, Continue, Claude Code, Aider).

## [0.2.2] - 2026-06-25

### Changed

- opencode is configured natively: the key goes to its `auth.json` store instead
  of global environment variables.

## [0.2.1] - 2026-06-24

### Changed

- English README and expanded npm metadata.

## [0.2.0] - 2026-06-23

### Added

- Five more tools: opencode, Aider, Kilo Code, Roo Code and Continue.

## [0.1.1] - 2026-06-23

### Added

- A live request to the gateway after setup, proving the key, URL and model work.

### Fixed

- OpenClaw: the key format that produced HTTP 401; providers are merged with
  OpenClaw's bundled ones (`models.mode: "merge"`).

## [0.1.0] - 2026-06-19

### Added

- Initial release: one command to point Claude Code, OpenClaw and Cline at
  JoinGonka Gateway.

