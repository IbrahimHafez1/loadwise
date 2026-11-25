import type { sourceFacts } from '../source-facts.js';

/** What the scan gathers from a source file's text while it already holds it. */
export type SourceFacts = ReturnType<typeof sourceFacts>;
