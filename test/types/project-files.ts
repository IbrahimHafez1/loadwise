/** Relative file path -> file text, as written into a temporary test project. */
export type FileMap = Record<string, string>;

/** Like FileMap, but non-string values are written as JSON. */
export type JsonFileMap = Record<string, string | object>;

/** Result of running the CLI as a child process. */
export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}
