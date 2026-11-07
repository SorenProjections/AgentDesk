# WorkBuddy adapter for Paperclip

An external `workbuddy_local` adapter extracted from AgentDesk's local CLI integration.
This prototype uses WorkBuddy's installed headless CLI. It does not bundle or modify
the WorkBuddy application.

## Requirements

- Node.js 24.11 or later on the Paperclip host.
- A locally installed WorkBuddy CLI with `--print`, `--input-format`,
  `--output-format`, `--resume`, and `--permission-mode` support.
- A working **CLI login**. A desktop login alone may not authenticate the CLI.
- Paperclip's adapter contract from `@paperclipai/adapter-utils` 2026.1005.0.

## Install locally

From this directory, run:

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
```

Register this directory with Paperclip's external-adapter API using `localPath`;
see the official [local installation instructions](https://github.com/paperclipai/paperclip/blob/master/docs/adapters/external-adapters.md#installation).
The package root exports `createServerAdapter()`, which Paperclip's
external adapter loader expects. Choose `workbuddy_local` when configuring an agent.
The package is not published to npm.

For a portable package, run `npm pack`. The package includes its source, smoke script,
manifest, README, and license; tests, reports, local configurations, and dependencies
are excluded.

## Agent configuration

Use the bundled JavaScript CLI entry with `cliPath`, or a native executable with
`command`. Do not set both. The example paths below are placeholders:

```json
{
  "cwd": "C:\\Projects\\example",
  "cliPath": "C:\\Apps\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\dist\\codebuddy-headless.js",
  "configDir": "C:\\Users\\YOUR_USER\\.workbuddy",
  "permissionMode": "dontAsk",
  "timeoutSec": 7200
}
```

`configDir` is passed as `CODEBUDDY_CONFIG_DIR`. Its default is `~/.workbuddy`.
Authenticate the installed CLI with the same configuration before using it here.
Client versions may use additional default cache locations.

Optional fields are `model`, `effort`, `graceSec`, `instructionsFilePath`,
`promptTemplate`, and `env`. Leave model and effort empty to use the client defaults.
`env` must contain resolved string values; use Paperclip's secret resolution rather
than storing credentials in files. It cannot override `PAPERCLIP_*` run identity.

Paperclip task and wake context are passed through stdin. Assigned runtime skills
are read from the server's materialized skill directories and included in each turn.
An `instructionsFilePath` can supply additional instructions. The adapter does not
install skills into the user's global client configuration. Runtime tool gateway
credentials are passed through Paperclip's environment helpers.

`dontAsk` denies tools that lack permission. It does **not** bypass permissions.
`default` uses the client's permission behavior and may require user interaction.
CLI file and network access follow the client's configuration; this prototype does
not provide a separate filesystem sandbox.

## Execution behavior

- A successful run needs an explicit successful result, a nonempty reply, and a
  successful process exit. EOF or an assistant message alone is insufficient.
- Permission denials and structured error results fail the run. Words such as
  "unauthorized" in ordinary assistant text do not classify authentication failures.
- Session state records the conversation ID, working directory, config directory,
  and CLI identity. A changed identity starts fresh and requests a host handoff when
  that optional host API is available. Failed resumes are never silently replayed.
- Operator cancellation and timeout stop the owned process tree on Windows; POSIX
  execution uses the owned process group. Provider stop is acknowledged after exit.
- Reported token usage is per run. Only a supplied cost is reported; absent costs
  remain `unpriced` rather than being fabricated or estimated.
- Run logs and persisted summaries redact known credentials. Prompts and environment
  values are not included in invocation metadata.

## Diagnostics and real smoke test

The environment diagnostic runs `--help` only. It verifies required flags and
returns `warn` because authentication and model access are still unverified.

Put an agent configuration in a local JSON file outside version control, then run:

```powershell
npm run smoke -- --config C:\local\workbuddy-smoke.json --report C:\local\workbuddy-smoke-report.json
```

This sends two small, no-tool requests. The second must resume the same session.
It uses the account's model allowance. Reports omit prompts, credentials, and session
IDs. This is a runtime smoke test, not a complete Paperclip task lifecycle test.

The first real test on 2026-10-08 found the installed CLI and verified its required
flags. Task execution returned an explicit authentication error. Real successful
execution, real session resume, and a complete Paperclip task lifecycle remain
unverified until a CLI login is available.

## Current scope

Local headless execution only. This version does not control existing desktop
windows, observe desktop conversations, support SSH/sandbox targets, or inject
native client MCP configuration. Those features need separate designs and tests.
WorkBuddy's bundled CLI and independently installed CodeBuddy are distinct
integration targets even when their CLI protocols resemble each other.

Before proposing core integration, discuss the scope with Paperclip maintainers
and search for related work. See [Paperclip's contribution guide](https://github.com/paperclipai/paperclip/blob/master/CONTRIBUTING.md).

## License

MIT, copyright 2026 SorenProjections. Adapted from AgentDesk's independently authored
CLI integration. No third-party client code, binaries, or login data are included.
