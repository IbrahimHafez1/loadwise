# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.5.x   | Yes       |
| < 0.5.0 | No        |

## Reporting a Vulnerability

Please report security vulnerabilities privately through [GitHub Security Advisories](https://github.com/IbrahimHafez1/loadwise/security/advisories/new) instead of opening a public issue.

Include a brief description of the issue, steps to reproduce (or a minimal fixture), and any affected CLI flags or modes. You can expect an initial response within 72 hours and updates as a fix is prepared.

## Scope

Loadwise runs locally on your source files, configs, traces, and query plans and does not send telemetry. Issues that could lead to unintended file writes, command execution via untrusted project inputs, or sandbox/path escapes in `--fix` or MCP tools are in scope.
