import { requireReview } from '../../performance/site-fixes/helpers.js';
import type { FixResult, SiteFixBuilder, SiteFixInput } from '../../shared/types.js';

function dockerfileRunsAsRootFix({ finding, text }: SiteFixInput): FixResult | undefined {
  if (text === undefined || finding.line === undefined) return;
  const lines = text.split('\n');
  const lineIndex = finding.line - 1;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const targetLine = lines[lineIndex];
  if (/^\s*USER\s+(?:root|0)\b/i.test(targetLine)) {
    const start = lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0);
    return {
      edits: [{ start, end: start + targetLine.length, text: 'USER nonroot' }],
      note: 'Switches the final container user from `root` to `nonroot`.',
    };
  }
  const cmdIndex = lines.findLastIndex((line) => /^\s*(?:CMD|ENTRYPOINT)\b/i.test(line));
  const insertAt = cmdIndex >= 0 ? lines.slice(0, cmdIndex).join('\n').length + (cmdIndex > 0 ? 1 : 0) : text.length;
  const prefix = insertAt === text.length && text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  return {
    edits: [{ start: insertAt, end: insertAt, text: `${prefix}USER nonroot\n` }],
    note: 'Adds `USER nonroot` before the container entrypoint.',
  };
}

function dockerfileAddRemoteUrlFix({ finding, text }: SiteFixInput): FixResult | undefined {
  if (text === undefined || finding.line === undefined) return;
  const lines = text.split('\n');
  const lineIndex = finding.line - 1;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const match = /^\s*ADD\s+(https?:\/\/\S+)\s+(\S+)\s*$/i.exec(lines[lineIndex]);
  if (!match) return;
  const start = lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0);
  return {
    edits: [{ start, end: start + lines[lineIndex].length, text: `RUN curl -fsSL ${match[1]} -o ${match[2]}` }],
    note: 'Replaces `ADD <url>` with `RUN curl -fsSL`; add a checksum verification step if available.',
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'dockerfile-runs-as-root': requireReview(
    'Ensure the `nonroot` user exists in the base image and owns any required runtime files.',
    dockerfileRunsAsRootFix,
  ),
  'dockerfile-add-remote-url': requireReview(
    'Ensure `curl` is installed in the image and verify a SHA-256 checksum for the downloaded file.',
    dockerfileAddRemoteUrlFix,
  ),
};

export default builders;
