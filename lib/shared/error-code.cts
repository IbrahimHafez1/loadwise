// What a caught value says, without assuming it is an Error: `catch` variables are `unknown`.

/** The Node.js system error code (`ENOENT`, `EEXIST`, ...) of a caught value, if it carries one. */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { errorCode, errorMessage };
