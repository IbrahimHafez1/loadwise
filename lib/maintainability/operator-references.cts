import path from 'node:path';
import ts from 'typescript';

const maxDocumentBytes = 1024 * 1024;
const sourcePath = /^(?![-/])(?:[\w.-]+\/)*[\w.-]+\.[cm]?[jt]sx?$/;
const nodeInvocation = /^\s*(?:\$\s+)?node\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))(?=\s|$)/;
const containerInvocation =
  /^\s*(?:CMD|ENTRYPOINT|command:|entrypoint:)\s*\[\s*["']?node["']?\s*,\s*["']?([\w./-]+)["']?\s*[,\]]/i;

function readSmallFile(root: string, file: string): string {
  const absolute = path.join(root, file);
  const size = ts.sys.getFileSize?.(absolute);
  if (size !== undefined && size <= maxDocumentBytes) return ts.sys.readFile(absolute) || '';
  return '';
}

// A path in a runbook can use either the project root or the document's directory.
// Ambiguous destinations cannot establish a reference to either file.
function localScript(target: string | undefined, directory: string, known: ReadonlySet<string>): string | undefined {
  if (target === undefined || !sourcePath.test(target) || target.split('/').includes('..')) return;
  const relative = path.posix.normalize(target);
  const adjacent = path.posix.join(directory, target);
  if (known.has(relative) && (relative === adjacent || !known.has(adjacent))) return relative;
  if (!known.has(relative) && known.has(adjacent)) return adjacent;
}

function collectMarkdown(
  text: string,
  directory: string,
  known: ReadonlySet<string>,
  commands: Set<string>,
  mentions: Set<string>,
): void {
  let fence: string | undefined;
  let shell = false;
  for (const line of text.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) {
        fence = delimiter[1];
        shell = /^(?:sh|bash|shell|console|zsh|powershell|pwsh|cmd|bat|text|plaintext)?$/i.test(delimiter[2].trim());
      } else if (delimiter[1].startsWith(fence) && !delimiter[2].trim()) fence = undefined;
      continue;
    }
    // Later lines may be heredoc contents or run in a different directory.
    if (fence && /<<|(?:^|[;&|])\s*(?:cd|pushd|popd|Set-Location)\b/i.test(line)) shell = false;
    const spans: string[] = fence ? [] : Array.from(line.matchAll(/`([^`\n]+)`/g), (match) => match[1]);
    if (fence && shell) spans.push(line);
    for (const span of spans) {
      const command = nodeInvocation.exec(span);
      if (!command && fence) continue;
      const target = command ? command.slice(1).find(Boolean) : span;
      const file = localScript(target, directory, known);
      if (file) (command ? commands : mentions).add(file);
    }
  }
}

function collectContainerCommands(
  text: string,
  directory: string,
  known: ReadonlySet<string>,
  targets: Set<string>,
): void {
  for (const line of text.split(/\r?\n/)) {
    const target = containerInvocation.exec(line)?.[1];
    const destination = target && localScript(target, directory, known);
    if (destination) targets.add(destination);
  }
}

function operatorReferences(
  root: string,
  inventory: readonly string[],
  known: ReadonlySet<string>,
): { commands: Set<string>; mentions: Set<string> } {
  const commands = new Set<string>();
  const mentions = new Set<string>();
  const containerTargets = new Set<string>();
  for (const file of inventory) {
    const directory = path.posix.dirname(file);
    if (/\.md$/i.test(file)) {
      collectMarkdown(readSmallFile(root, file), directory, known, commands, mentions);
    } else if (
      /^(?:Dockerfile(?:\.[\w-]+)?|(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml)$/i.test(path.posix.basename(file))
    ) {
      collectContainerCommands(readSmallFile(root, file), directory, known, containerTargets);
    }
  }
  // Container paths can be remapped by COPY or volumes. Require independent source-side evidence.
  for (const file of containerTargets) if (mentions.has(file)) commands.add(file);
  return { commands, mentions };
}

export { operatorReferences };
