import type { SizeLimits } from './types/policy.js';

// Defaults for the size rules; the "maintainability" config section can override each one under "limits".
const defaultLimits: SizeLimits = { largeModuleLines: 600, largeClassMembers: 30, longParameterCount: 5 };

export { defaultLimits };
