import {
  createExperimentRecord,
  ExperimentCreateInput,
  ExperimentRun,
  updateExperimentRecord,
} from '../api';

function notifyExperimentStoreChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('sionna-experiments-changed'));
}

export async function safeCreateExperiment(input: ExperimentCreateInput): Promise<ExperimentRun | null> {
  try {
    const created = await createExperimentRecord(input);
    notifyExperimentStoreChanged();
    return created;
  } catch (error) {
    console.warn('[experiment-log] Could not persist experiment start/result:', error);
    return null;
  }
}

export async function safeUpdateExperiment(
  id: string | null | undefined,
  patch: Parameters<typeof updateExperimentRecord>[1],
): Promise<void> {
  if (!id) return;
  try {
    await updateExperimentRecord(id, patch);
    notifyExperimentStoreChanged();
  } catch (error) {
    console.warn('[experiment-log] Could not update experiment record:', error);
  }
}

export function canonicalJson(value: unknown): string {
  const normalize = (item: any): any => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
    }
    if (typeof item === 'number' && !Number.isFinite(item)) return null;
    return item;
  };
  return JSON.stringify(normalize(value));
}

export async function sha256Json(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(value));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  // The backend recomputes and stores the authoritative SHA-256 fingerprint.
  return '';
}

export function summarizeMeasurementRayTrace(result: any): Record<string, unknown> {
  return {
    datasetId: result.datasetId,
    filename: result.filename,
    profile: result.profile,
    transmitter: result.transmitter,
    frequencyGhz: result.frequencyGhz,
    frequencySource: result.frequencySource,
    maxDepth: result.maxDepth,
    rxHeightAglM: result.rxHeightAglM,
    sampleCountRequested: result.sampleCountRequested,
    sampleCountReturned: result.sampleCountReturned,
    validSimulationCount: result.validSimulationCount,
    noPathCount: result.noPathCount,
    medianSimulatedTotalRxPowerDbm: result.medianSimulatedTotalRxPowerDbm,
    medianSimulatedChannelGainDb: result.medianSimulatedChannelGainDb,
    medianMeasuredRsrpDbm: result.medianMeasuredRsrpDbm,
    rfConfigurationFingerprint: result.configurationFingerprint,
    rfConfiguration: result.rfConfiguration,
    warnings: result.warnings,
    // Preserve the sampled paired values so the generated validation report can
    // audit them. The report intentionally does not derive RMSE from unlike
    // quantities (total RT power versus modem SS-RSRP).
    validationRows: result.results,
  };
}

export function summarizeUnknownExperimentResult(kind: string, value: any): Record<string, unknown> {
  if (kind === 'link_solve') {
    return { metrics: value.metrics, pathCount: value.paths?.length ?? 0 };
  }
  if (kind === 'link_matrix') {
    const pairs = Array.isArray(value.solvedPairs) ? value.solvedPairs : null;
    return { pairCount: pairs?.length ?? Object.keys(value.matrix ?? {}).length, solvedPairs: pairs, matrix: value.matrix };
  }
  if (kind === 'radio_map') {
    return {
      mapId: value.mapId, cellCount: value.cells?.length ?? 0,
      metric: value.metric, unit: value.unit, stats: value.stats,
      txStats: value.txStats, siteStats: value.siteStats,
    };
  }
  if (kind === 'mobility') {
    const steps = Array.isArray(value.steps) ? value.steps : [];
    const powers = steps.map((step: any) => step.receivedPowerDbm).filter(Number.isFinite);
    return {
      stepCount: steps.length, execution: value.execution, handover: value.handover,
      meanReceivedPowerDbm: powers.length ? powers.reduce((a: number, b: number) => a + b, 0) / powers.length : null,
      minReceivedPowerDbm: powers.length ? Math.min(...powers) : null,
      maxReceivedPowerDbm: powers.length ? Math.max(...powers) : null,
    };
  }
  if (kind === 'link_kpi') {
    return {
      throughputMbps: value.throughputMbps,
      capacityOpenLoopBitsHz: value.capacityOpenLoopBitsHz,
      capacityBeamformedBitsHz: value.capacityBeamformedBitsHz,
      conditionNumberDb: value.conditionNumberDb,
      effectiveRank: value.effectiveRank,
      beamformingGainDb: value.beamformingGainDb,
    };
  }
  if (kind === 'channel_analysis') {
    return {
      mapId: value.mapId, frequencyGhz: value.frequencyGhz,
      execution: value.execution, locations: value.locations,
    };
  }
  if (kind === 'phy_sweep') {
    return {
      points: value.points, mcsIndex: value.mcsIndex, mcsTable: value.mcsTable,
      channelMode: value.channelMode, seed: value.seed, numPrb: value.numPrb,
      linkBudgetEbNoDb: value.linkBudgetEbNoDb, effectiveSnrDb: value.effectiveSnrDb,
      rxPowerDbm: value.rxPowerDbm, noisePowerDbm: value.noisePowerDbm,
    };
  }
  return value && typeof value === 'object' ? value : { value };
}
