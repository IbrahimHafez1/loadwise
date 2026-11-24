// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.cjs.
import type { SiteFixBuilder } from '../../shared/types.cjs';

const builders: Record<string, SiteFixBuilder> = {};

export default builders;
