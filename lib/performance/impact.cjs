'use strict';

// Loop findings know the shape of the cost, not the trip count, so a fixed count keeps the arithmetic readable.
const illustrativeItems = 1000;
const millisecondsPerSecond = 1000;

function isLoopRule(ruleId) {
  return ruleId.endsWith('-query-in-loop') || ruleId === 'sequential-http-in-loop';
}

// The batched query still pays one round trip, which is exactly what the snapshot measured.
function loopImpact(snapshot) {
  const roundTrip = snapshot?.roundTrip;
  if (!roundTrip) return { kind: 'estimated', before: 'N', after: 1, unit: 'round trips', method: 'query count model' };
  const probe = snapshot.dialect === 'mongo' ? 'ping' : 'SELECT 1';
  const capturedOn = typeof snapshot.capturedAt === 'string' ? ' on ' + snapshot.capturedAt.slice(0, 10) : '';
  return {
    kind: 'estimated',
    measured: ['after'],
    before: illustrativeItems * roundTrip.medianMs,
    after: roundTrip.medianMs,
    unit: 'ms',
    method:
      `round trip measured (median of ${roundTrip.runs} ${probe} from the CLI host${capturedOn}) x ` +
      `${illustrativeItems.toLocaleString('en-US')} illustrative items; excludes query execution`,
  };
}

function formatNumber(value) {
  return value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 });
}

function formatAmount(value, unit) {
  if (typeof value !== 'number') return `${value} ${unit}`;
  if (unit === 'ms' && value >= millisecondsPerSecond) return formatNumber(value / millisecondsPerSecond) + ' s';
  const singular = value === 1 && unit.endsWith('s') && unit !== 'ms' ? unit.slice(0, -1) : unit;
  return `${formatNumber(value)} ${singular}`;
}

function formatSide(impact, side) {
  const measured = impact.kind === 'measured' || impact.measured?.includes(side);
  const value = impact[side];
  const approximate = !measured && typeof value === 'number' ? '~' : '';
  return `${approximate}${formatAmount(value, impact.unit)} ${measured ? 'measured' : 'estimated'}`;
}

// Returns undefined for a millisecond impact with nothing measured behind it, which must never be printed.
function formatImpact(impact) {
  if (!impact) return;
  if (impact.unit === 'ms' && impact.kind !== 'measured' && !impact.measured?.length) return;
  const method = String(impact.method).replace(/\.$/, '');
  return `Impact: ${formatSide(impact, 'before')} -> ${formatSide(impact, 'after')}; method: ${method}.`;
}

module.exports = { isLoopRule, loopImpact, formatImpact };
