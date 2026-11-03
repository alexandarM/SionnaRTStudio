import type { BuildingFootprint, MaterialConfig, Receiver, SolverOptions, Transmitter } from '../types';

/**
 * Inputs that determine whether cached ray-tracing results are still valid.
 * Active TX/RX selection is intentionally excluded: selecting a solved pair
 * must not invalidate the all-pairs matrix.
 */
export interface SolveContextInputs {
  buildings: BuildingFootprint[];
  txs: Transmitter[];
  rxs: Receiver[];
  freqGhz: number;
  maxDepth: number;
  solverOptions: SolverOptions;
  materialConfigs: Record<string, MaterialConfig>;
}

export function createSolveContextKey(input: SolveContextInputs): string {
  return JSON.stringify({
    buildings: input.buildings,
    txs: input.txs,
    rxs: input.rxs,
    freqGhz: input.freqGhz,
    maxDepth: input.maxDepth,
    solverOptions: input.solverOptions,
    materialConfigs: input.materialConfigs,
  });
}

/** Prevent sub-millimetre WGS84/ENU round-trip noise from creating a new solve context. */
export function enuPositionChanged(
  current: { x: number; y: number; z: number },
  next: { x: number; y: number; z: number },
  toleranceM = 0.001,
): boolean {
  return (
    Math.abs(current.x - next.x) > toleranceM ||
    Math.abs(current.y - next.y) > toleranceM ||
    Math.abs(current.z - next.z) > toleranceM
  );
}
