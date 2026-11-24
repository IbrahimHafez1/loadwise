import fs from 'node:fs';
import path from 'node:path';
import { runCheck } from '../lib/shared/check.cjs';
import { renderReports } from '../lib/shared/formats/index.cjs';
import type { ReportEntry } from '../lib/shared/types/report-formats.cjs';

const {
  GITHUB_OUTPUT,
  RUNNER_TEMP,
  LOADWISE_CHECKERS,
  LOADWISE_PATH,
  LOADWISE_CHANGED_ONLY,
  LOADWISE_BASE_SHA,
  LOADWISE_FAIL_ON,
  LOADWISE_UPLOAD_SARIF,
  LOADWISE_ANNOTATIONS,
} = process.env;

type ReportEntries = readonly ReportEntry[];

function requiredEnvironment(value: string | undefined, name: string): string {
  if (value === undefined) throw new TypeError(`${name} is not set`);
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const upload = LOADWISE_UPLOAD_SARIF === 'true';
const annotate = LOADWISE_ANNOTATIONS === 'true';

async function run(): Promise<number> {
  const args: string[] = [];
  if (LOADWISE_CHECKERS) args.push('--only', LOADWISE_CHECKERS);
  if (LOADWISE_CHANGED_ONLY === 'true') {
    if (LOADWISE_BASE_SHA) args.push('--changed-since', LOADWISE_BASE_SHA);
    else console.warn('Warning: changed-only is true but base SHA is empty; running a full scan.');
  }
  if (LOADWISE_FAIL_ON) args.push('--fail-on', LOADWISE_FAIL_ON);
  if (upload || annotate) args.push('--format', upload ? 'sarif' : 'github');
  args.push('--', LOADWISE_PATH || '.');

  let reportsForUpload: ReportEntries | undefined;
  function actionFormats(_format: string, entries: ReportEntries): string {
    if (upload && entries.some(({ report }) => report)) reportsForUpload = entries;
    return annotate ? renderReports('github', entries) : '';
  }

  const exitCode = await runCheck(args, undefined, actionFormats);
  if (reportsForUpload && exitCode !== 2) {
    const directory = await fs.promises.mkdtemp(
      path.join(requiredEnvironment(RUNNER_TEMP, 'RUNNER_TEMP'), 'loadwise-report-'),
    );
    const sarifFile = path.join(directory, 'loadwise.sarif');
    await fs.promises.writeFile(sarifFile, renderReports('sarif', reportsForUpload));
    await fs.promises.appendFile(requiredEnvironment(GITHUB_OUTPUT, 'GITHUB_OUTPUT'), `sarif-file=${sarifFile}\n`);
  }
  return exitCode;
}

run()
  .catch((error: unknown) => {
    console.error(messageOf(error));
    return 2;
  })
  // The composite action uploads SARIF before applying the checker exit code.
  .then((exitCode) => fs.appendFileSync(requiredEnvironment(GITHUB_OUTPUT, 'GITHUB_OUTPUT'), `exit-code=${exitCode}\n`))
  .catch((error: unknown) => {
    console.error(messageOf(error));
    process.exitCode = 2;
  });
