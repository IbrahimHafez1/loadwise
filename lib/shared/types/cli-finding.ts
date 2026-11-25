/** The location and rule of one finding as `loadwise perf --json` prints it. */
export interface CliFinding {
  file: string;
  line: number;
  column: number;
  ruleId: string;
}
