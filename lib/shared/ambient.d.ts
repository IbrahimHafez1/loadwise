// Declarations for modules that ship no types of their own.
declare module '@ast-grep/cli/postinstall.js' {
  /** The path of the ast-grep binary installed for this platform. */
  export function resolveBinaryPath(): string;
}
