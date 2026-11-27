import type { CompilerOptions, StringLiteralLike } from 'typescript';

/**
 * Resolves an import specifier to a project-relative file, or undefined when it leaves the scanned
 * files.
 */
export interface SpecifierResolver {
  (
    specifier: string,
    containingFileAbsolute: string,
    usageNode?: StringLiteralLike,
    outsideProject?: () => void,
  ): string | undefined;
}

/** A resolver that can also say which compiler options apply to a project file. */
export interface ModuleResolver extends SpecifierResolver {
  optionsFor(filename: string): CompilerOptions | undefined;
}
