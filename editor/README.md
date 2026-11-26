# Loadwise

Without this extension, `npx loadwise perf editor init` in the consuming project gives inline diagnostics and plain-text hovers through the editor's built-in task system (open the trusted folder and allow automatic tasks). It refreshes on saves, terminal source scans and checker package updates. Choose one integration per workspace to avoid duplicate diagnostics.

This extension shows performance and maintainability findings inline in VS Code or Cursor. Save a source file and hover over an underline to read the recommendation. Hover over the flagged code to compare the current snippet with a syntax-highlighted suggested rewrite; short comparisons also appear on the first diagnostic line. Rules without a site-specific rewrite show the flagged line and a labeled illustrative alternative.

Open **View → Problems** to browse both checkers. Each entry identifies its source and rule and links to the reported code. Use **Loadwise: Scan Workspace** from the Command Palette to refresh immediately. **Loadwise: Show Output** lists scan counts and errors. The status bar shows when a scan is running, the number of findings and the time of the last scan; click it to open the output.

## Fix or dismiss a finding

Every finding is an optional suggestion. A line with a fix shows **Apply fix** and **Dismiss** buttons above it, the hover has the same two links, and the first line of a file with several fixes shows **Apply all**. Turn the buttons off with `loadwise.codeLens`.

The keyboard shortcuts are the same on Windows, Linux and macOS (on macOS, Ctrl is Control and Alt is Option):

| Keys             | Action                                   |
| ---------------- | ---------------------------------------- |
| Ctrl+Alt+.       | Apply the fix on the cursor's line       |
| Ctrl+Alt+Shift+. | Apply all fixes in the file              |
| Ctrl+Alt+,       | Dismiss the finding on the cursor's line |

The editor's own Quick Fix menu (Ctrl+. on Windows and Linux, Cmd+. on macOS) offers the same actions:

- **Apply fix: <rule>** applies the checker's rewrite when it has one. Hover first to compare the current code with the rewrite. Fixes that span several files, or create a migration file, apply all-or-nothing. A fix never overwrites an existing file or code that changed since the scan.
- **Dismiss this finding** hides it until the flagged line changes. **Dismiss <rule> in this file** hides the rule for the whole file. Dismissals are kept per workspace and never written into your code. **Loadwise: Show dismissed findings** restores one or all of them.
- **Loadwise: Apply all fixes in this file** groups eligible fixes into one undoable edit. The summary counts fixes that need individual review. Read the note for each of those and use **Apply fix** on its line. To apply eligible fixes on save, add `"editor.codeActionsOnSave": { "source.fixAll.loadwise": "explicit" }` to your settings.

The Problems view honors rule levels from your project configuration. By default it shows declared contract violations as errors and other findings as warnings. Set `loadwise.severity` to `error`, `warning`, `information` or `hint` to show all of them at one level. Live-database findings, which name a table rather than a file, appear on the first line of `package.json`.

## Install

Install the universal VSIX through **Extensions: Install from VSIX…**. The bundle includes both checkers and TypeScript. The native parser covers Windows x86, x64 and Arm64, Intel and Apple silicon Macs, and Linux x64 and Arm64 with glibc or musl. The editor itself must support your OS and architecture. Minimal musl images need the native parser's libgcc runtime. The editor needs Node.js 22 or newer on its PATH to launch the checkers. Source scanning runs locally.

## What gets scanned

The extension scans on opening a supported workspace and refreshes whenever files change, whether saved in the editor or changed by git, another editor or a code generator. Source files, `schema.prisma`, SQL migrations, `package.json`, `tsconfig*.json`, `jsconfig*.json`, `maintainability.config.json`, `backend-perf.policy.json` and `loadwise.config.json` are watched, and rapid changes are grouped. The performance checker runs in its incremental watch mode, so only changed files are re-analyzed; it restarts when a config file changes, and full rescans take over if it stops. The maintainability checker scans the folder. The performance checker uses its root `tsconfig.json` or `jsconfig.json` and also runs its polyglot source rules if it finds Python, Go, Java, C# or Rust. In a monorepo, open individual packages as workspace folders or set `loadwise.project` to the intended config. CLI traces and database plans are separate inputs.

Each folder uses the checkers' default rules and its existing policy files. You can turn off diagnostics for a folder with `loadwise.enabled`. Developers using their own build can point the user setting `loadwise.cli` at the absolute path of its `bin/loadwise.js`.

## Build the extension

Run the packager from the loadwise repository with Python 3.10+, Node.js 22+ and npm. It downloads the pinned `@vscode/vsce` and the locked runtime packages through npm.

```sh
python editor/package-vsix.py
```

It writes `editor/dist/loadwise-<version>.vsix`. Pass an output path to override it.
