import path from 'node:path';
import { scanPolyglot } from '../performance/polyglot.js';
import type { PolyglotFinding, PolyglotScan } from '../performance/polyglot.js';

const securityConfig = path.resolve(import.meta.dirname, '../../polyglot/security/sgconfig.yml');

/** Run ast-grep polyglot security checks on the given files or directories. */
async function checkSecurityPolyglot(paths: readonly string[]): Promise<PolyglotScan> {
  return scanPolyglot(securityConfig, paths);
}

export { checkSecurityPolyglot };
export type { PolyglotFinding, PolyglotScan };
