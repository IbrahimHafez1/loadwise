// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.cjs.
import type { SiteFixBuilder } from '../../shared/types.js';

const builders: Record<string, SiteFixBuilder> = {};

export default builders;
