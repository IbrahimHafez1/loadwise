'use strict';

// Defaults for the size rules; maintainability.config.json can override each one under "limits".
const defaultLimits = { largeModuleLines: 600, largeClassMembers: 30, longParameterCount: 5 };

module.exports = { defaultLimits };
