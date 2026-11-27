import assert from 'node:assert/strict';

/** Stands in for a fix's file writer and keeps the text of the last write. */
export interface WriteRecorder {
  writeFile(file: string, text: string): void;
  /** The text last written; fails the test when nothing was written. */
  written(): string;
}

export function recordWrite(): WriteRecorder {
  let lastText: string | undefined;
  return {
    writeFile(_file, text) {
      lastText = text;
    },
    written() {
      assert.ok(lastText !== undefined, 'expected the fix to write the file');
      return lastText;
    },
  };
}
