const ABSENT_PATH_CODES = ['ENOENT', 'ENOTDIR'];
const reportedNotes = new Set<string>();

interface UnreadableNote {
  error: unknown;
  location: string;
  consequence: string;
  absentCodes?: readonly string[];
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined;
  const property: unknown = Reflect.get(value, key);
  return typeof property === 'string' ? property : undefined;
}

// A path that is simply absent is expected; one that exists but cannot be read loses coverage, said
// once per cause.
function noteUnreadable({ error, location, consequence, absentCodes = [] }: UnreadableNote) {
  const code = stringProperty(error, 'code');
  if (code !== undefined && (ABSENT_PATH_CODES.includes(code) || absentCodes.includes(code))) return;
  const cause = code ?? stringProperty(error, 'name');
  noteOnce(JSON.stringify([consequence, cause]), `Note: could not read ${location} (${cause}); ${consequence}.`);
}

function noteOnce(key: string, message: string) {
  if (reportedNotes.has(key)) return;
  reportedNotes.add(key);
  console.error(message);
}

function resetCoverageNotes() {
  reportedNotes.clear();
}

export { noteOnce, noteUnreadable, resetCoverageNotes };
