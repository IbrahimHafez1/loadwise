import type { Finding } from '../../lib/shared/types.cjs';

/** A finding as the security analyzer reports it: the position is always known. */
export interface LocatedFinding extends Finding {
  file: string;
  line: number;
  column: number;
}

/**
 * The JSON `loadwise sec --json` prints; `loadwise check` nests the same shape under `security`.
 */
export interface SecReport {
  findings: LocatedFinding[];
  scannedFiles?: number;
  security?: SecReport;
  [section: string]: unknown;
}
