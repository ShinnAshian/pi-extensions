# Fork Changes (`@estebanforge/pi-antigravity-bridge`)

This repository is a fork of [EstebanForge/pi-extensions](https://github.com/EstebanForge/pi-extensions) containing enhancements to `packages/pi-antigravity-bridge` built on top of upstream `v1.16.0`.

## File Inventory (vs. Upstream `1.16.0`)

| File | Status | Purpose |
| --- | --- | --- |
| `src/accounts.ts` | Added | Multi-account encrypted OS keyring vault, async keyring helpers, multi-log email detection, and quota-exhaustion auto-rotation |
| `src/image-tool.ts` | Added | Official `agy` CLI `generate_image` tool + `.tempmediaStorage` artifact extraction |
| `src/codemode-description.ts` | Added | Pi 1.6.0-style inline `Nested tools:` TypeScript declaration generator for bridged `codemode` |
| `extensions/index.ts` | Modified | Windows `agy.exe` fallback discovery, `/agy accounts`, `/agy` Quota row & `/agy quota` TUI modal, `/agy image` commands/picker, quota rotation wiring, pure codemode catalog, external compression hooks |
| `src/usage.ts` | Modified | Framed interactive `/agy` quota GUI modal (`showQuotaModal`, `buildQuotaModalBody`), relative reset countdowns, and inline summary (`formatQuotaInlineSummary`) |
| `src/config.ts` | Modified | New config keys & env vars; default `bridgeTools` flipped from `"all"` to `"codemode"` |
| `src/bridge-catalog.ts` | Modified | Exposure-aware `codemodeNestedTools`, pure `codemodeCatalog` with `directTools`, inline TS descriptions |
| `src/provider.ts` | Modified | `buildCodemodePriorityNote`, external compression shrink rotation (`shouldRotateOnTranscriptShrink`), `compress` digest preservation, `onQuotaExhausted` rotation hook |
| `tests/accounts.test.ts` | Added | Vitest unit tests for account storage, auto-numbering, switching, and quota cooldown rotation |
| `tests/codemode-description.test.ts` | Added | Vitest unit tests for `buildCodemodeBridgeDescription`, `codemodeNestedTools`, `codemodeCatalog`, `buildCodemodePriorityNote`, and compression rotation/digest |
| `tests/image-tool.test.ts` | Added | Vitest unit tests for `imageAgentMd`, `selectImageDriverModel`, MIME mapping, path resolution, and prompt formatting |
| `tests/usage-gui.test.ts` | Added | Portable Vitest unit tests for quota modal rendering, countdown formatting, and inline summaries |
| `tests/config.test.ts`, `tests/bridge-catalog.test.ts`, `tests/provider-sysprompt.test.ts` | Modified | Updated assertions to match the fork's `"codemode"` default, pure catalog description, and `buildCodemodePriorityNote` output |

---

## Added Features

### 1. Multi-Account Management & Automatic Quota Rotation
- **Encrypted OS Keyring Vault (`src/accounts.ts`)**:
  - Snapshots and switches `agy`'s native OS keyring credential (`gemini:antigravity`) across named or auto-numbered slots in `<agentDir>/antigravity-bridge/accounts.json`.
  - **Windows**: DPAPI encryption (`ProtectedData.Protect` / `DataProtectionScope.CurrentUser`) stored in `accounts.json` and Windows Credential Manager read/write/delete via PowerShell.
  - **macOS / Linux**: `security` Keychain CLI on macOS, `secret-tool` on Linux, and `0600` vault permissions. Secrets are passed over `stdin` (never `argv`).
  - **Non-blocking async keyring I/O**: All PowerShell / Keychain / `secret-tool` calls run asynchronously so Pi's TUI event loop stays responsive during account switches and rotations.
- **Auto-Numbered Slots & Multi-Log Email Detection**:
  - `saveCurrentAccount()` auto-assigns the lowest unused integer (`"1"`, `"2"`, ...) or reuses an existing slot matching the detected email (case-insensitive).
  - `detectActiveAccountEmail()` inspects `cli.log` and the newest `log/*.log` files (including `acp-login-*.log`, where `agy acp --login` writes the signed-in address).
- **Interactive Picker & `/agy accounts` Commands (`extensions/index.ts`)**:
  - `/agy` TUI picker gains an **Accounts** submenu (switch, browser login, save current, remove with confirmation) and an **Auto-rotate accounts** toggle.
  - `/agy accounts list` (or bare `/agy accounts`)
  - `/agy accounts save [name]`
  - `/agy accounts use <name>` (switches keyring credential, recycles `stream-json` and `acp` drivers, clears bound sessions)
  - `/agy accounts login [name]` (clears active credential, spawns `agy acp --login`, relays the browser authorization code to `agy`'s `stdin` via `ui.input()`, then saves & recycles drivers)
  - `/agy accounts remove <name>`
  - `/agy accounts auto on|off`
- **Automatic Rotation on Quota Exhaustion (`src/provider.ts`, `extensions/index.ts`)**:
  - When `agy` returns a quota-exhaustion notice, `rotateAccountOnQuota` marks the current slot in cooldown (parsed from `resetsIn`, default 30m, capped at 7d), switches to the next non-cooling slot, recycles drivers, and clears the stale session binding so a retry continues on the new account.
  - Controlled by `autoRotateAccounts` / `AGY_AUTO_ROTATE_ACCOUNTS` (default `true`).

### 2. Official-CLI `generate_image` Tool (`src/image-tool.ts`, `extensions/index.ts`)
- Registers the `generate_image` Pi tool (default `true`, controlled by `imageTool` / `AGY_IMAGE_TOOL` / `/agy image on|off`) and supports direct invocation via `/agy image <prompt>`.
- Spawns a one-shot restricted `agy` agent (`imageAgentMd`) exposing only `agy`'s native `generate_image` tool (no MCP bridge inheritance), selects a flash/gemini entry from the discovered catalog (`selectImageDriverModel`), and extracts generated media from `agy`'s `.tempmediaStorage` artifact directory (with text-path fallback).
- Supports `prompt`, `aspectRatio` (`1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`), `path` (output file or directory; defaults under `.pi/generated-images/`), and up to 4 `referenceImages`.
- Returns both image summary text and an inline image content block to Pi, and automatically triggers account quota rotation + one retry if the run hits a quota limit.

### 3. Pi 1.6.0 Pure Codemode & Inline Nested-Tool Declarations (`src/codemode-description.ts`, `src/bridge-catalog.ts`, `src/provider.ts`)
- **Inline `Nested tools:` TypeScript Catalog**: `buildCodemodeBridgeDescription()` synthesizes Pi 1.6.0-style TypeScript declarations (`declare const tools: { ... }`) directly inside the bridged `codemode` tool description within `codemodeInlineBudget` (default `4000` estimated tokens), appending an unlisted summary when truncated.
- **Exposure-Aware Filtering**: `codemodeNestedTools()` mirrors Pi 1.6.0 callable tool visibility (excludes `deferred`, `hidden`, `model-only`, and session-hidden tools; keeps `codemode`-exposed tools and active `direct` tools).
- **Pure Codemode + Direct Companion Tools**:
  - `codemodePure` (`AGY_CODEMODE_PURE`, default `true`) omits redundant `bridge_tool_info` / `bridge_call_tool` proxies because scripts can discover unlisted tools inside `codemode` via `ALL_TOOLS`, `searchTools()`, and `describeTool()`.
  - `codemodeDirectTools` (`AGY_CODEMODE_DIRECT_TOOLS`, default `["ask_user_question"]`) keeps listed interactive tools exposed alongside `codemode`.
- **Cohesive Tool Priority Prompt**: `buildCodemodePriorityNote()` replaces the two-part legacy priority + codemode note when running in codemode mode, clearly listing direct MCP tools alongside `codemode` and avoiding references to removed proxies.

### 4. External Context Compression Sync (`src/provider.ts`, `extensions/index.ts`)
- Detects external context compression (such as `billion-context-pi`'s `compress` tool or `codemode` calls producing `▣ ACP |` output) via `tool_result` + `agent_end` hooks in `extensions/index.ts` and pre-turn `shouldRotateOnTranscriptShrink()` checks in `src/provider.ts`.
- Automatically rotates the bound `agy` conversation so server-side history stays aligned with Pi's compacted transcript (`rotateOnContextCompression` / `AGY_ROTATE_ON_COMPRESSION`, default `true`).
- Preserves `compress` and `tools.compress(` summary payloads up to `COMPRESS_SUMMARY_CAP` (`6000` chars) inside handoff digests via `renderCompressToolCall()` instead of clipping them at the 200-char generic tool-call cap.

### 5. Windows `agy.exe` Discovery Fallback (`extensions/index.ts`)
- `resolveAgyBinary()` falls back to `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows when `AGY_BIN` is unset (e.g., shells opened before `agy` was added to `PATH`), setting `AGY_BIN` and prepending its directory to `PATH`.

### 6. Interactive `/agy` Quota GUI (`src/usage.ts`, `extensions/index.ts`)
- **`Quota` Row in `/agy` Picker**: Displays a compact per-account cached summary via `formatQuotaInlineSummary()` (e.g., `Gemini 74%/86% · Claude/GPT 100% (5m ago)`, or `Enter to check` before the first check) and opens the framed quota overlay on `Enter`.
- **Framed Quota Overlay (`showQuotaModal`, `buildQuotaModalBody`)**: Uses `@estebanforge/pi-tui-dialogs` `frameDialog` backed by zero-token `agy --print /usage --output-format json`, listing the active account label, update clock, `5h limit` before `Weekly`, color-coded 20-segment bars (`success` >= 50%, `warning` >= 20%, `error` < 20%), relative countdown + reset clock (`formatQuotaResetDetail`), and per-group model descriptions. Supports `r` refresh, `a` switch accounts, `b`/`Backspace` back to `/agy`, and `Esc`/`Enter`/`q` close.
- **`/agy quota` Integration & Cache Invalidation**: Opens `showQuotaModal` directly in TUI mode (keeping the plain-text `formatAgyQuotaReport` output in headless/non-TUI mode) and automatically clears the per-account session quota cache on account switch, login, or quota-exhaustion auto-rotation.

---

## Modified Defaults & Behavior

Compared to upstream `@estebanforge/pi-antigravity-bridge@1.15.1`:

| Setting / Env Var | Upstream Default | Fork Default | Notes |
| --- | --- | --- | --- |
| `bridgeTools` / `AGY_BRIDGE_TOOLS` | `"all"` | `"codemode"` | Runs Pi tools inside `codemode` by default; revert via `/agy bridge all` or `AGY_BRIDGE_TOOLS=all` |
| `codemodeDirectTools` / `AGY_CODEMODE_DIRECT_TOOLS` | _(none)_ | `["ask_user_question"]` | Comma-separated in env (`""` for none) |
| `codemodePure` / `AGY_CODEMODE_PURE` | _(none)_ | `true` | Set `false` / `0` to keep `bridge_tool_info` and `bridge_call_tool` proxies |
| `codemodeInlineBudget` / `AGY_CODEMODE_INLINE_BUDGET` | _(none)_ | `4000` | Estimated token budget (`0`–`50000`) for inline `Nested tools:` declarations |
| `imageTool` / `AGY_IMAGE_TOOL` | _(none)_ | `true` | Registers Pi's `generate_image` tool via official `agy` CLI |
| `autoRotateAccounts` / `AGY_AUTO_ROTATE_ACCOUNTS` | _(none)_ | `true` | Auto-rotates saved accounts in `accounts.json` on quota exhaustion |
| `rotateOnContextCompression` / `AGY_ROTATE_ON_COMPRESSION` | _(none)_ | `true` | Rotates bound `agy` conversations after external context compression / shrink |

---

## Installing This Fork

Clone the repository and point Pi at `packages/pi-antigravity-bridge`:

```bash
git clone https://github.com/ShinnAshian/pi-extensions.git
pi install ./pi-extensions/packages/pi-antigravity-bridge
```

Or reference the local package directory in `~/.pi/agent/settings.json` under `packages`.
