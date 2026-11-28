import type { FixExample } from './types/fix-example.js';

const guards = new Map([
  [
    'javascript',
    `for (const record of records) {
  if (!isReady(record)) continue;
  processRecord(record);
}`,
  ],
  [
    'python',
    `for record in records:
    if not is_ready(record):
        continue
    process_record(record)`,
  ],
  [
    'go',
    `for _, record := range records {
    if !isReady(record) {
        continue
    }
    processRecord(record)
}`,
  ],
  [
    'java',
    `for (Record record : records) {
    if (!isReady(record)) continue;
    processRecord(record);
}`,
  ],
  [
    'csharp',
    `foreach (var record in records) {
    if (!IsReady(record)) continue;
    ProcessRecord(record);
}`,
  ],
  [
    'rust',
    `for record in &records {
    if !is_ready(record) {
        continue;
    }
    process_record(record);
}`,
  ],
  [
    'php',
    `foreach ($records as $record) {
    if (!isReady($record)) continue;
    processRecord($record);
}`,
  ],
  [
    'ruby',
    `records.each do |record|
  next unless ready?(record)
  process_record(record)
end`,
  ],
  [
    'kotlin',
    `for (record in records) {
    if (!isReady(record)) continue
    processRecord(record)
}`,
  ],
  [
    'c',
    `for (size_t i = 0; i < count; ++i) {
    if (!is_ready(&records[i])) continue;
    process_record(&records[i]);
}`,
  ],
  [
    'cpp',
    `for (const auto& record : records) {
    if (!isReady(record)) continue;
    processRecord(record);
}`,
  ],
]);

const sharedChecks = new Map([
  [
    'javascript',
    `function inRange(value, lower, upper) {
  return lower <= value && value <= upper;
}`,
  ],
  [
    'typescript',
    `function inRange(value: number, lower: number, upper: number) {
  return lower <= value && value <= upper;
}`,
  ],
  [
    'python',
    `def in_range(value, lower, upper):
    return lower <= value <= upper`,
  ],
  [
    'go',
    `func inRange(value, lower, upper int) bool {
    return lower <= value && value <= upper
}`,
  ],
  [
    'java',
    `static boolean inRange(int value, int lower, int upper) {
    return lower <= value && value <= upper;
}`,
  ],
  [
    'csharp',
    `static bool InRange(int value, int lower, int upper) =>
    lower <= value && value <= upper;`,
  ],
  [
    'rust',
    `fn in_range(value: i32, lower: i32, upper: i32) -> bool {
    (lower..=upper).contains(&value)
}`,
  ],
]);

function placementExample(message: string): FixExample {
  const policy = /^The project places files ending in ([\w.-]+) under ([\w./-]+)\.(?:\n|$)/.exec(message ?? '');
  if (policy) {
    return {
      language: 'plaintext',
      code: policy[2] + '/example' + policy[1],
      note: 'This example matches the reported rule. Keep your filename when moving the file, and update references.',
    };
  }
  return {
    language: 'plaintext',
    code: '<one of the allowed directories>/<existing filename>',
    note: 'Use a directory listed in this finding. Move the file and update references to its previous location.',
  };
}

function exampleFor(ruleId: string, languageId: string, message: string): FixExample | undefined {
  if (ruleId === 'file-placement') return placementExample(message);
  const language =
    languageId === 'javascriptreact' ? 'javascript' : languageId === 'typescriptreact' ? 'typescript' : languageId;
  const script = language === 'javascript' || language === 'typescript';
  switch (ruleId) {
    case 'deep-control-flow': {
      const code = guards.get(script ? 'javascript' : language);
      if (code)
        return {
          language,
          code,
          note: 'When a branch skips the rest of an iteration, check that condition first. Preserve side effects and cleanup on both paths.',
        };
      break;
    }
    case 'duplicate-implementation': {
      const code = sharedChecks.get(language);
      if (code)
        return {
          language,
          code,
          note: 'For example, if both callers validate the same inclusive range, extract this predicate and call it from both sites. First compare their input, error and boundary behavior.',
        };
      break;
    }
    case 'high-branch-complexity':
      if (script)
        return {
          language,
          code: `const handlers = new Map([
  ['draft', saveDraft],
  ['ready', publish],
]);
const handle = handlers.get(status) ?? rejectUnknownStatus;
const result = handle(record);`,
          note: 'A handler table fits mutually exclusive cases with the same input and return contract. Preserve what the original code does for an unknown status.',
        };
      break;
    case 'dependency-cycle':
      if (script)
        return {
          language,
          code:
            language === 'typescript'
              ? '// shared/price.ts\nexport const lineTotal = (price: number, units: number) => price * units;'
              : '// shared/price.js\nexport const lineTotal = (price, units) => price * units;',
          note: 'If a shared calculation caused the cycle, move it to a module that imports neither caller. Each original module can then import lineTotal directly from the shared module.',
        };
      break;
    case 'folder-boundary':
      if (script)
        return {
          language,
          code:
            language === 'typescript'
              ? `export function summarize(count: number) {
  return { count };
}

// In the layer allowed to call both modules:
const summary = summarize(await loadCount());`
              : `export function summarize(count) {
  return { count };
}

// In the layer allowed to call both modules:
const summary = summarize(await loadCount());`,
          note: 'If an inner module only needs the result of an operation, the permitted outer layer can obtain that value and pass it in.',
        };
      break;
    case 'query-mutates-state':
      if (script)
        return {
          language,
          code: `class Counter {
  count = 0;

  /** @maintainabilityQuery */
  current() { return this.count; }

  increment() { this.count += 1; }
}`,
          note: 'Keep the read side-effect free. Have the caller invoke the command explicitly when it needs to advance the counter.',
        };
      break;
  }
}

export { exampleFor };
