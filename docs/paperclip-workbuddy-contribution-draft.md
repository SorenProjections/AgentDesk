# WorkBuddy adapter contribution draft

This is a local draft. No issue, pull request, or package has been published.
The implementation currently lives in AgentDesk; an upstream PR would need its
changes placed into Paperclip's agreed package layout after maintainer review.

## Proposed title

Add a local WorkBuddy external adapter

## Proposed scope discussion

I have a prototype external adapter for WorkBuddy's bundled local headless CLI.
It exports `createServerAdapter()` and targets the released Paperclip adapter SDK
2026.1005.0. Before proposing a built-in adapter, would maintaining this as a
community external package fit the project's direction?

The scope is local CLI task execution and session resume. WorkBuddy desktop
observation, desktop automation, SSH targets, and native MCP configuration are
outside this first contribution. WorkBuddy and independently installed CodeBuddy
are distinct integration targets even though their CLI protocols resemble each other.

Related CodeBuddy work: [issue #11765](https://github.com/paperclipai/paperclip/issues/11765)
and [PR #11766](https://github.com/paperclipai/paperclip/pull/11766).

## Proposed implementation description

Paperclip can dispatch a task to WorkBuddy's installed CLI and persist its returned
session for later turns. The adapter supplies task and wake context through stdin,
delivers assigned runtime skill instructions, and passes the host's run identity
and runtime tool gateway environment. Conversation state is scoped to the working
directory, client configuration directory, and CLI entry point.

Runs succeed only after a structured successful final result, a nonempty response,
and a successful process exit. Permission denials, missing final results, and
process failures remain failures. Cancellation and timeout stop the owned process
tree, and failed attempts are not automatically replayed. Known credentials are
redacted from logs and stored summaries. Missing cost information stays unpriced.

The default permission mode is `dontAsk`. The package contains adapter code and a
smoke script, with no WorkBuddy binary or authentication data.

## Validation and remaining checks

- Strict JavaScript/TypeScript checking against the released SDK passes.
- 21 tests pass, including subprocess execution, prompt transport, session identity,
  assigned skills, fresh handoff, UTF-8 streaming, redaction, cancellation, and
  timeout cleanup of a child process.
- AgentDesk's existing 46 tests pass.
- The generated tarball installs in an isolated directory. Its factory, config
  schema, session codec, and bundled smoke script load successfully.
- A real installed WorkBuddy CLI advertises the required flags. The first real
  task returned an authentication error, so successful real execution and resume
  have not yet been verified.
- A full Paperclip task lifecycle, including task API updates under the supplied
  run identity, still needs verification in a disposable instance.
- Windows behavior has automated coverage on this machine. POSIX process-group
  cleanup is implemented but has not been run here.

This should remain a prototype or draft contribution until the real-client and
Paperclip lifecycle checks are complete.
