// Text helpers shared by the Postgres and MySQL inspections of `loadwise perf db`.
import * as snapshot from './snapshot.cjs';
import type { RelationalGateway } from '../types/db-connection.cjs';

export const dmlStart = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;

export function formatMs(value: number | string) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: Number(value) < 10 ? 1 : 0 });
}

export async function roundTripInUnit(gateway: RelationalGateway) {
  return gateway.unit(() => snapshot.measureRoundTrip(() => gateway.catalog('roundTrip')));
}
