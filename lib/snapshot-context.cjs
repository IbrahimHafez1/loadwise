'use strict';

// A before/after tree in an archive is useful evidence only when a live counterpart exists.
function archivedCopies(files) {
  const snapshots = new Map();
  const suffixes = new Set();
  for (const file of files) {
    const match = /(?:^|\/)(?:handoffs?|archives?|snapshots?)\/(?:[^/]+\/)*?(?:before|after|baseline)\/(.+\/.+)/i.exec(file);
    if (match) { snapshots.set(file, match[1]); suffixes.add(match[1]); }
  }
  const confirmed = new Set();
  if (!snapshots.size) return confirmed;
  const live = new Set();
  for (const file of files) {
    if (snapshots.has(file)) continue;
    let suffix = file;
    while (suffix.includes('/')) {
      if (suffixes.has(suffix)) live.add(suffix);
      suffix = suffix.slice(suffix.indexOf('/') + 1);
    }
  }
  for (const [file, suffix] of snapshots) if (live.has(suffix)) confirmed.add(file);
  return confirmed;
}

function sourceContext(finding, snapshots, generated) {
  if (!['high-branch-complexity','deep-control-flow','duplicate-implementation'].includes(finding.ruleId)) return;
  if (finding.ruleId === 'duplicate-implementation') {
    const sites = [finding, ...(finding.related ?? [])];
    if (sites.every(site => !snapshots.has(site.file)) || sites.filter(site => !snapshots.has(site.file)).length >= 2) return;
    return 'Historical snapshot locations account for the duplicate group.';
  }
  if (generated.has(finding.file)) return 'This source is marked as generated; review the generator.';
  if (snapshots.has(finding.file)) return 'Archived before/after source has a corresponding live project file.';
}

module.exports = {archivedCopies, sourceContext};
