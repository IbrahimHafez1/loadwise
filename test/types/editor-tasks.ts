/** The capture-group numbers of the problem matcher, keyed by the marker field each one reads. */
export interface ProblemMatcherPattern {
  regexp: string;
  file: number;
  line: number;
  column: number;
  endColumn: number;
  severity: number;
  code: number;
  message: number;
}

export interface ProblemMatcher {
  owner?: string;
  source?: string;
  pattern: ProblemMatcherPattern;
  fileLocation: string[];
  background: { beginsPattern: string; endsPattern: string };
}

/** A task of `.vscode/tasks.json` as the editor setup writes it. */
export interface EditorTask {
  label: string;
  type: string;
  command: string;
  args: string[];
  isBackground: boolean;
  runOptions: { runOn: string; instanceLimit: number };
  presentation?: { reveal?: string };
  options?: { cwd: string };
  problemMatcher: ProblemMatcher;
}

export interface TasksFile {
  tasks: EditorTask[];
}
