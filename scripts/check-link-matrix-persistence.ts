import { createSolveContextKey, enuPositionChanged } from '../src/lib/solveContext';
import type { BuildingFootprint, MaterialConfig, Receiver, SolverOptions, Transmitter } from '../src/types';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
}
function assertNotEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual === expected) throw new Error(`${message}: values unexpectedly match`);
}

const buildings = [] as BuildingFootprint[];
const txs = [{
  id: 'tx-1', name: 'TX 1', latitude: 45, longitude: 19, height: 25,
  enu: { x: 10, y: 20, z: 0 }, powerDbm: 30, antennaArraySize: [8, 8],
  beamsteeringAzimuth: 90, beamsteeringElevation: 0,
}] as Transmitter[];
const rxs = [{
  id: 'rx-1', name: 'RX 1', latitude: 45.001, longitude: 19.001, height: 1.5,
  enu: { x: 80, y: 90, z: 0 }, antennaArraySize: [1, 1],
}] as Receiver[];
const solverOptions = {} as SolverOptions;
const materialConfigs = {} as Record<string, MaterialConfig>;

const base = createSolveContextKey({ buildings, txs, rxs, freqGhz: 3.5, maxDepth: 5, solverOptions, materialConfigs });

// Selecting another solved TX/RX pair changes active IDs only. Active IDs are
// intentionally not accepted by the solve-context key, so cached matrix data
// remains valid.
const afterPairSelection = createSolveContextKey({ buildings, txs, rxs, freqGhz: 3.5, maxDepth: 5, solverOptions, materialConfigs });
assertEqual(afterPairSelection, base, 'pair selection must not invalidate solved matrix inputs');

const movedTxs = txs.map((tx) => ({ ...tx, enu: { ...tx.enu, x: tx.enu.x + 2 } }));
const afterGeometryEdit = createSolveContextKey({ buildings, txs: movedTxs, rxs, freqGhz: 3.5, maxDepth: 5, solverOptions, materialConfigs });
assertNotEqual(afterGeometryEdit, base, 'a real TX movement must invalidate solved matrix inputs');

assertEqual(enuPositionChanged({ x: 1, y: 2, z: 3 }, { x: 1.0002, y: 2, z: 3 }), false, 'sub-mm conversion noise must not count as a geometry edit');
assertEqual(enuPositionChanged({ x: 1, y: 2, z: 3 }, { x: 1.01, y: 2, z: 3 }), true, 'a centimetre-scale movement must count as a geometry edit');

console.log('Link matrix persistence checks passed.');
