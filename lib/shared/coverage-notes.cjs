'use strict';

const ABSENT_PATH_CODES = ['ENOENT', 'ENOTDIR'];
const reportedNotes = new Set();

// A path that is simply absent is expected; one that exists but cannot be read loses coverage, said once per cause.
function noteUnreadable({ error, location, consequence, absentCodes = [] }) {
  if (ABSENT_PATH_CODES.includes(error.code) || absentCodes.includes(error.code)) return;
  const cause = error.code ?? error.name;
  noteOnce(JSON.stringify([consequence, cause]), `Note: could not read ${location} (${cause}); ${consequence}.`);
}

function noteOnce(key, message) {
  if (reportedNotes.has(key)) return;
  reportedNotes.add(key);
  console.error(message);
}

function resetCoverageNotes() {
  reportedNotes.clear();
}

module.exports = { noteOnce, noteUnreadable, resetCoverageNotes };
