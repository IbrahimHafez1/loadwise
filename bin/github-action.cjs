'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runCheck } = require('../lib/shared/check.cjs');
const { renderReports } = require('../lib/shared/formats/index.cjs');

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

const upload = LOADWISE_UPLOAD_SARIF === 'true';
const annotate = LOADWISE_ANNOTATIONS === 'true';

async function run() {
  const args = [];
  if (LOADWISE_CHECKERS) args.push('--only', LOADWISE_CHECKERS);
  if (LOADWISE_CHANGED_ONLY === 'true' && LOADWISE_BASE_SHA) args.push('--changed-since', LOADWISE_BASE_SHA);
  if (LOADWISE_FAIL_ON) args.push('--fail-on', LOADWISE_FAIL_ON);
  if (upload || annotate) args.push('--format', upload ? 'sarif' : 'github');
  args.push('--', LOADWISE_PATH || '.');

  let reportsForUpload;
  function actionFormats(_format, entries) {
    if (upload && entries.some(({ report }) => report)) reportsForUpload = entries;
    return annotate ? renderReports('github', entries) : '';
  }

  const exitCode = await runCheck(args, undefined, actionFormats);
  if (reportsForUpload && exitCode !== 2) {
    const directory = await fs.promises.mkdtemp(path.join(RUNNER_TEMP, 'loadwise-report-'));
    const sarifFile = path.join(directory, 'loadwise.sarif');
    await fs.promises.writeFile(sarifFile, renderReports('sarif', reportsForUpload));
    await fs.promises.appendFile(GITHUB_OUTPUT, `sarif-file=${sarifFile}\n`);
  }
  return exitCode;
}

run()
  .catch((error) => {
    console.error(error.message);
    return 2;
  })
  // The composite action uploads SARIF before applying the checker exit code.
  .then((exitCode) => fs.appendFileSync(GITHUB_OUTPUT, `exit-code=${exitCode}\n`))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
