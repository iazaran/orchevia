# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities. Instead, open a
[private security advisory](https://github.com/iazaran/orchevia/security/advisories/new)
or contact the maintainers directly. We aim to acknowledge reports within 72 hours.

## Trust model

Orchevia executes local commands **on your behalf**. The design principles:

- **Explicit execution only.** Opening, importing, or previewing a workflow never runs
  anything. Runs start from the ▶ Run button or an approved resume.
- **No implicit shell.** Executables and argument lists are passed separately to the OS; shell
  metacharacters in arguments are inert. Command previews are shell-escaped for display
  only. Command nodes can explicitly invoke a shell or interpreter.
- **Visible commands.** The inspector shows exactly which executable + arguments will run;
  run history records exit codes, stdout/stderr (truncated), and errors.
- **Cancellation + timeouts.** Runs can be cancelled (in-flight child processes are
  killed); commands have a bounded timeout.
- **Authentication stays in your tools.** Orchevia has no credential fields and
  does not persist environment dumps. Workflow text and command output are stored
  locally and may contain sensitive information. Do not paste credentials into
  workflow fields; review output before sharing.
- **Untrusted content.** Ticket/PR text, imported workflows, and AI output are treated as
  untrusted input — review before running.
- **Local-first.** No analytics, no telemetry, no accounts, no Orchevia cloud. Third-party
  CLIs (Claude Code, Codex) may contact their own providers per their own behavior; that is
  outside Orchevia's control and is disclosed in the Environment screen.

## Known limitations (honest)

- macOS builds are currently **unsigned** (Gatekeeper friction documented in README).
- Approval gates pause durably, but a run interrupted by a crash mid-command is marked
  failed on next launch rather than resumed mid-command — resuming arbitrary external
  processes automatically would be unsafe.
