// Output formats shared by `loadwise check`, `loadwise perf` and `loadwise maint`. Text and json
// are printed by each checker; the others are built from the same report objects json prints.
import type { ReportEntry } from '../types/report-formats.cjs';
import { formatSarif } from './sarif.cjs';
import { formatGithub } from './github.cjs';

type OutputFormat = 'text' | 'json' | 'sarif' | 'github';
type RenderedFormat = 'sarif' | 'github';
type FormatRenderer = (entries: readonly ReportEntry[]) => string;

const formatNames: readonly OutputFormat[] = ['text', 'json', 'sarif', 'github'];
const renderers: Record<RenderedFormat, () => FormatRenderer> = {
  sarif: () => formatSarif,
  github: () => formatGithub,
};

// --json is an alias of --format json.
function isOutputFormat(value: string): value is OutputFormat {
  return formatNames.some((name) => name === value);
}

function isRenderedFormat(value: string): value is RenderedFormat {
  return Object.hasOwn(renderers, value);
}

function resolveFormat({ format, json }: { format?: string; json?: boolean }): OutputFormat {
  if (format !== undefined && !isOutputFormat(format)) {
    throw new Error(`--format must be ${formatNames.join(', ')}.`);
  }
  if (json && format !== undefined && format !== 'json')
    throw new Error('--json cannot be combined with --format ' + format + '.');
  return format ?? (json ? 'json' : 'text');
}

// entries: [{ pillar: 'performance' | 'maintainability', root, report }]
function renderReports(format: string, entries: readonly ReportEntry[]): string {
  if (!isRenderedFormat(format)) throw new Error(`No renderer for the ${format} format.`);
  return renderers[format]()(entries);
}

export { formatNames, resolveFormat, renderReports };
