import type { FixChange } from '../../shared/types.cjs';

/** How a fix reads and writes the project files it changes. */
export interface FileAccessors {
  readFile(file: string): string;
  writeFile(file: string, text: string): void;
}

/** Receives each change as it is applied, with the lines it really replaced. */
export type CaptureChange = (change: FixChange) => void;

/** A capture that also records the changes it saw once the write is confirmed. */
export interface ChangeCapture extends CaptureChange {
  commit(): void;
}

/** What `--fix` takes from the command line besides the findings. */
export interface FixRunOptions {
  json?: boolean;
  /** `false` leaves out the why-comment above each fixed statement. */
  comments?: boolean;
  /** `false` skips formatting the changed lines. */
  format?: boolean;
}
