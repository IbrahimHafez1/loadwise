'use strict';

// Test fixtures emulate ordinary terminals unless they explicitly select an agent session.
process.env.LOADWISE_AGENT = '0';
// Tests scan throwaway projects; caching their results would only fill the user's cache folder.
process.env.LOADWISE_NO_CACHE = '1';
