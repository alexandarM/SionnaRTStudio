/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Database, Download, FileSpreadsheet,
  Filter, Loader2, MapPin, RefreshCw, Upload, Crosshair, Globe2, Square,
} from 'lucide-react';
import {
  exportMeasurementCsv,
  getMeasurementDataset,
  getMeasurementRows,
  importMeasurementCsv,
  listMeasurementDatasets,
  MeasurementDataset,
  MeasurementDatasetListItem,
  MeasurementRowsResponse,
  MeasurementGeospatialAudit,
  MeasurementSceneBounds,
  runMeasurementGeospatialAudit,
  exportGeoreferencedMeasurementCsv,
  runMeasurementMatchingAudit,
  MeasurementMatchingAudit,
  MeasurementRayTraceResult, startMeasurementRayTraceJob, getMeasurementRayTraceJob,
  cancelMeasurementRayTraceJob,
} from '../api';
import { GeoAnchor, Transmitter, BuildingFootprint, SolverOptions, MaterialConfig, MeasurementOverlayPoint } from '../types';
import { buildAllMeasurementOverlayPoints, buildMeasurementOverlayPoints, MeasurementOverlaySourceRow } from '../lib/measurementOverlay';
import { safeCreateExperiment, safeUpdateExperiment, sha256Json, summarizeMeasurementRayTrace } from '../lib/experimentLogging';

interface FieldValidationPanelProps {
  backendOnline: boolean;
  anchor: GeoAnchor;
  sceneBounds: MeasurementSceneBounds | null;
  transmitters: Transmitter[];
  rxArraySize: [number, number];
  buildings: BuildingFootprint[];
  freqGhz: number;
  maxDepth: number;
  solverOptions: SolverOptions;
  materials: MaterialConfig[];
  onShowMeasurementsIn3D: (points: MeasurementOverlayPoint[], label: string) => void;
  onClearMeasurementOverlay: () => void;
}

const fmt = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const fmtDate = (value: string | null) => value ? new Date(value).toLocaleString() : '—';

function StatCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft,var(--page))] p-3 min-w-0">
      <div className="eyebrow text-[var(--text-lo)]">{label}</div>
      <div className="mt-1 text-xl font-semibold font-mono text-[var(--text-hi)] truncate">{value}</div>
      {detail && <div className="mt-1 text-xs text-[var(--text-lo)]">{detail}</div>}
    </div>
  );
}

export function FieldValidationPanel({ backendOnline, anchor, sceneBounds, transmitters, rxArraySize, buildings, freqGhz, maxDepth, solverOptions, materials, onShowMeasurementsIn3D, onClearMeasurementOverlay }: FieldValidationPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [datasets, setDatasets] = useState<MeasurementDatasetListItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [dataset, setDataset] = useState<MeasurementDataset | null>(null);
  const [rows, setRows] = useState<MeasurementRowsResponse | null>(null);
  const [ratFilter, setRatFilter] = useState('');
  const [pciFilter, setPciFilter] = useState('');
  const [validOnly, setValidOnly] = useState(true);
  const [spatialOnly, setSpatialOnly] = useState(false);
  const [busy, setBusy] = useState<'list' | 'upload' | 'load' | 'rows' | 'export' | 'georef' | 'matching' | 'raytrace' | 'overlay' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [geoAudit, setGeoAudit] = useState<MeasurementGeospatialAudit | null>(null);
  const [matchingAudit, setMatchingAudit] = useState<MeasurementMatchingAudit | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [overlayDisplayMode, setOverlayDisplayMode] = useState<'unique' | 'individual' | 'all_records'>('unique');
  const [overlayRatFilter, setOverlayRatFilter] = useState('');
  const [overlayPciFilter, setOverlayPciFilter] = useState('');
  const [overlayValidOnly, setOverlayValidOnly] = useState(false);
  const [raytraceTxId, setRaytraceTxId] = useState('');
  const [raytraceSampleCount, setRaytraceSampleCount] = useState(25);
  const [raytraceRxHeight, setRaytraceRxHeight] = useState(1.5);
  const [raytraceMaxDepth, setRaytraceMaxDepth] = useState(maxDepth);
  const [raytracePathSamples, setRaytracePathSamples] = useState(solverOptions.pathSamplesPerSource);
  const [raytracePathSeed, setRaytracePathSeed] = useState(solverOptions.pathSeed);
  const [raytraceResult, setRaytraceResult] = useState<MeasurementRayTraceResult | null>(null);
  const [raytraceJobId, setRaytraceJobId] = useState<string | null>(null);
  const [raytraceExperimentId, setRaytraceExperimentId] = useState<string | null>(null);
  const [raytraceProgress, setRaytraceProgress] = useState(0);
  const raytraceStartedAt = useRef<number>(0);

  // Poll a cancellable measurement-location ray-trace job. The experiment row is
  // created before the job ID is exposed, preventing a React-effect race where
  // the first poll could capture a null experiment ID.
  useEffect(() => {
    if (!raytraceJobId) return;
    let disposed = false;
    let timer: number | undefined;
    let failures = 0;
    const schedule = (ms: number) => { if (!disposed) timer = window.setTimeout(poll, ms); };
    const poll = async () => {
      if (disposed) return;
      try {
        const status = await getMeasurementRayTraceJob(raytraceJobId);
        if (disposed) return;
        failures = 0;
        setRaytraceProgress(status.progress);
        setMessage(status.message || 'Ray-tracing job running…');
        if (status.status === 'done' && status.result) {
          setRaytraceResult(status.result);
          setMessage(`Ray tracing completed: ${status.result.validSimulationCount}/${status.result.sampleCountReturned} locations have at least one valid path.`);
          await safeUpdateExperiment(raytraceExperimentId, {
            status: 'done', completedAtUtc: new Date().toISOString(),
            durationMs: raytraceStartedAt.current ? performance.now() - raytraceStartedAt.current : undefined,
            results: summarizeMeasurementRayTrace(status.result), error: null,
          });
          setRaytraceJobId(null); setRaytraceExperimentId(null); setBusy(null);
          return;
        }
        if (status.status === 'error') {
          setError(status.message || 'Measurement ray tracing failed.');
          await safeUpdateExperiment(raytraceExperimentId, { status: 'error', completedAtUtc: new Date().toISOString(), durationMs: raytraceStartedAt.current ? performance.now() - raytraceStartedAt.current : undefined, error: status.message || 'Measurement ray tracing failed.' });
          setRaytraceJobId(null); setRaytraceExperimentId(null); setBusy(null);
          return;
        }
        if (status.status === 'cancelled') {
          setMessage(status.message || 'Ray-tracing job cancelled.');
          await safeUpdateExperiment(raytraceExperimentId, { status: 'cancelled', completedAtUtc: new Date().toISOString(), durationMs: raytraceStartedAt.current ? performance.now() - raytraceStartedAt.current : undefined, error: status.message || 'Cancelled by user.' });
          setRaytraceJobId(null); setRaytraceExperimentId(null); setBusy(null);
          return;
        }
        schedule(1500);
      } catch (error: any) {
        if (disposed) return;
        const messageText = error?.message || 'Measurement ray-trace status check failed';
        if (/unknown.*job|404/i.test(messageText)) {
          setError(`${messageText}. Backend job registry is unavailable.`);
          await safeUpdateExperiment(raytraceExperimentId, { status: 'error', completedAtUtc: new Date().toISOString(), error: `${messageText}. Backend job registry unavailable.` });
          setRaytraceJobId(null); setRaytraceExperimentId(null); setBusy(null);
          return;
        }
        failures += 1;
        setMessage(`Status check delayed (${messageText}); retrying…`);
        schedule(Math.min(15000, 1500 * (2 ** Math.min(failures - 1, 3))));
      }
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [raytraceJobId, raytraceExperimentId]);

  const refreshDatasets = useCallback(async (preferredId?: string, manageBusy = true) => {
    if (manageBusy) setBusy('list');
    setError('');
    try {
      const result = await listMeasurementDatasets();
      setDatasets(result.datasets);
      const nextId = preferredId || selectedId || result.datasets[0]?.datasetId || '';
      setSelectedId(nextId);
      if (nextId) {
        const found = result.datasets.some((item) => item.datasetId === nextId);
        if (found) {
          const loaded = await getMeasurementDataset(nextId);
          setDataset(loaded);
        } else {
          setDataset(null);
        }
      } else {
        setDataset(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (manageBusy) setBusy(null);
    }
  }, [selectedId]);

  useEffect(() => {
    if (backendOnline) void refreshDatasets();
  }, [backendOnline]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep these controls aligned with the main RF configuration whenever its
  // depth/sampling/seed settings change. Per-run edits remain local to this panel.
  useEffect(() => {
    setRaytraceMaxDepth(maxDepth);
    setRaytracePathSamples(solverOptions.pathSamplesPerSource);
    setRaytracePathSeed(solverOptions.pathSeed);
    setRaytraceResult(null);
  }, [maxDepth, solverOptions.pathSamplesPerSource, solverOptions.pathSeed]);

  // Invalidate a displayed ray-trace result whenever a physical input that
  // affects the next solve changes in the main Studio GUI.
  useEffect(() => {
    setRaytraceResult(null);
  }, [freqGhz, rxArraySize[0], rxArraySize[1], solverOptions.los,
      solverOptions.specularReflection, solverOptions.diffuseReflection,
      solverOptions.refraction, solverOptions.diffraction, solverOptions.edgeDiffraction,
      solverOptions.txPattern, solverOptions.txPolarization,
      solverOptions.rxPattern, solverOptions.rxPolarization, transmitters, buildings, materials]);

  const loadDataset = async (id: string) => {
    setSelectedId(id);
    onClearMeasurementOverlay();
    setGeoAudit(null);
    setMatchingAudit(null);
    setSelectedProfileId('');
    setRaytraceResult(null);
    setRaytraceTxId('');
    if (!id) { setDataset(null); setRows(null); return; }
    setBusy('load'); setError(''); setMessage('');
    try {
      const loaded = await getMeasurementDataset(id);
      setDataset(loaded);
      setRows(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDataset(null);
    } finally { setBusy(null); }
  };

  const uploadFile = async (file?: File) => {
    if (!file) return;
    setBusy('upload'); setError(''); setMessage('');
    try {
      const imported = await importMeasurementCsv(file);
      setDataset(imported);
      onClearMeasurementOverlay();
      setGeoAudit(null);
      setMatchingAudit(null);
      setSelectedProfileId('');
      setRaytraceResult(null);
      setRaytraceTxId('');
      setSelectedId(imported.datasetId);
      setRows(null);
      await refreshDatasets(imported.datasetId, false);
      setMessage(`Imported ${imported.summary.totalRows.toLocaleString()} rows from ${file.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const runFilter = async () => {
    if (!selectedId) return;
    setBusy('rows'); setError('');
    try {
      const result = await getMeasurementRows(selectedId, {
        rat: ratFilter || undefined,
        pci: pciFilter.trim() ? Number(pciFilter) : undefined,
        validOnly,
        spatialOnly,
        limit: 100,
        offset: 0,
      });
      setRows(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const downloadExport = async () => {
    if (!selectedId) return;
    setBusy('export'); setError('');
    try {
      const result = await exportMeasurementCsv(selectedId, spatialOnly);
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a'); a.href = url; a.download = result.filename; a.click();
      URL.revokeObjectURL(url);
      setMessage(`Eksportovan je ${result.filename}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const georeferenceRequest = useMemo(() => ({
    anchorLatitude: anchor.latitude,
    anchorLongitude: anchor.longitude,
    sceneBounds,
  }), [anchor.latitude, anchor.longitude, sceneBounds]);

  const runGeospatialAudit = async () => {
    if (!selectedId) return;
    setBusy('georef'); setError(''); setMessage('');
    try {
      const result = await runMeasurementGeospatialAudit(selectedId, georeferenceRequest);
      setGeoAudit(result);
      setMessage('Geospatial alignment audit completed for the active scene anchor.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setGeoAudit(null);
    } finally { setBusy(null); }
  };

  const downloadGeoreferencedExport = async () => {
    if (!selectedId) return;
    setBusy('export'); setError('');
    try {
      const result = await exportGeoreferencedMeasurementCsv(selectedId, georeferenceRequest);
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a'); a.href = url; a.download = result.filename; a.click();
      URL.revokeObjectURL(url);
      setMessage(`Eksportovan je ${result.filename}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const runRadioIdentityAudit = async (profileId?: string) => {
    if (!selectedId) return;
    setBusy('matching'); setError(''); setMessage('');
    try {
      const result = await runMeasurementMatchingAudit(selectedId, {
        anchorLatitude: anchor.latitude,
        anchorLongitude: anchor.longitude,
        sceneBounds,
        transmitters,
        rat: 'NR5G-NSA',
        ...(profileId ? { profileId } : { pci: 448 }),
        previewLimit: 12,
      });
      setMatchingAudit(result);
      onClearMeasurementOverlay();
      setSelectedProfileId(result.selectedProfile?.profileId ?? '');
      setRaytraceTxId((current) => result.candidateTransmitters.some((candidate) => candidate.txId === current)
        ? current : (result.candidateTransmitters[0]?.txId ?? ''));
      setRaytraceResult(null);
      setMessage('Radio identity and transmitter-candidate analysis completed. Sector mapping has not been automatically confirmed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMatchingAudit(null);
    } finally { setBusy(null); }
  };

  const runLocationRayTrace = async () => {
    if (!selectedId || !matchingAudit?.selectedProfile || !raytraceTxId || raytraceJobId) return;
    const selectedTx = transmitters.find((item) => item.id === raytraceTxId);
    if (!selectedTx) {
      setError('The selected transmitter is no longer part of the active scene. Run the radio identity audit again.');
      return;
    }
    const request = {
      anchorLatitude: anchor.latitude,
      anchorLongitude: anchor.longitude,
      sceneBounds,
      profileId: matchingAudit.selectedProfile.profileId,
      tx: selectedTx,
      buildings,
      freqGhz,
      maxDepth: raytraceMaxDepth,
      options: { ...solverOptions, pathSamplesPerSource: raytracePathSamples, pathSeed: raytracePathSeed },
      materials,
      rxHeightM: raytraceRxHeight,
      sampleCount: raytraceSampleCount,
      rxArraySize,
    };
    const startedAtUtc = new Date().toISOString();
    raytraceStartedAt.current = performance.now();
    setBusy('raytrace'); setError(''); setMessage('Creating experiment and starting PathSolver…');
    setRaytraceResult(null); setRaytraceProgress(0);
    const configuration = {
      datasetId: selectedId, profile: matchingAudit.selectedProfile, tx: selectedTx,
      freqGhz, maxDepth: raytraceMaxDepth, solverOptions: request.options, materials,
      rxHeightM: raytraceRxHeight, rxArraySize, sampleCount: raytraceSampleCount,
      scene: { anchor, sceneBounds, buildingCount: buildings.length, geometryFingerprint: await sha256Json(buildings).catch(() => '') },
    };
    const replay = {
      endpoint: `/api/measurements/${encodeURIComponent(selectedId)}/raytrace-jobs`,
      body: request as unknown as Record<string, unknown>,
      description: 'Repeat sampled Sionna RT at the same GPS measurement locations',
    };
    const experiment = await safeCreateExperiment({
      name: `Measurement RT · ${selectedTx.name} · PCI ${matchingAudit.selectedProfile.pci}`,
      kind: 'measurement_raytrace', status: 'running', startedAtUtc,
      seed: raytracePathSeed, configuration,
      parameters: { datasetId: selectedId, profileId: matchingAudit.selectedProfile.profileId, txId: selectedTx.id, freqGhz, maxDepth: raytraceMaxDepth, rxHeightM: raytraceRxHeight, sampleCount: raytraceSampleCount, pathSamplesPerSource: raytracePathSamples, pathSeed: raytracePathSeed },
      results: { status: 'queued' }, replay,
    });
    setRaytraceExperimentId(experiment?.id ?? null);
    try {
      const job = await startMeasurementRayTraceJob(selectedId, request);
      await safeUpdateExperiment(experiment?.id, { results: { jobId: job.jobId, status: 'running', progress: job.progress } });
      setRaytraceJobId(job.jobId);
      setMessage(job.message || 'PathSolver job queued.');
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      setError(errorText);
      await safeUpdateExperiment(experiment?.id, { status: 'error', completedAtUtc: new Date().toISOString(), durationMs: performance.now() - raytraceStartedAt.current, error: errorText });
      setRaytraceExperimentId(null); setBusy(null);
    }
  };

  const cancelLocationRayTrace = async () => {
    if (!raytraceJobId) return;
    try {
      const status = await cancelMeasurementRayTraceJob(raytraceJobId);
      setMessage(status.message || 'Cancellation requested. The active native PathSolver dispatch may need to return before it stops.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const showMeasurementsIn3D = async () => {
    if (!selectedId) return;
    const profileMode = overlayDisplayMode !== 'all_records';
    const profile = matchingAudit?.selectedProfile;
    if (profileMode && !profile) {
      setError('Run the Radio Identity & Transmitter Matching audit and select a radio profile first.');
      return;
    }
    if (profileMode && !matchingAuditMatchesCurrentScene) {
      setError('The scene anchor, geometry, or TX configuration changed after the audit. Run the radio identity audit again.');
      return;
    }

    setBusy('overlay'); setError(''); setMessage('');
    try {
      const collected: MeasurementRowsResponse['rows'] = [];
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      const allModePci = overlayPciFilter.trim() ? Number(overlayPciFilter) : undefined;
      while (offset < total) {
        const page = await getMeasurementRows(selectedId, profileMode && profile ? {
          rat: profile.rat,
          pci: profile.pci,
          validOnly: true,
          spatialOnly: true,
          limit: 500,
          offset,
        } : {
          rat: overlayRatFilter || undefined,
          pci: allModePci,
          validOnly: overlayValidOnly,
          spatialOnly: false,
          limit: 500,
          offset,
        });
        total = page.total;
        collected.push(...page.rows);
        offset += page.rows.length;
        if (page.rows.length === 0) break;
      }

      const sourceRows = collected as MeasurementOverlaySourceRow[];
      const points = overlayDisplayMode === 'all_records'
        ? buildAllMeasurementOverlayPoints(sourceRows, {
            rat: overlayRatFilter || undefined,
            pci: allModePci,
            validOnly: overlayValidOnly,
          })
        : buildMeasurementOverlayPoints(sourceRows, profile!, overlayDisplayMode);

      if (points.length === 0) {
        throw new Error('No records with valid GPS coordinates match the selected display mode and filters. Check the RAT, PCI, and validity filters.');
      }

      const displayedSourceRows = points.reduce((sum, point) => sum + point.samples.length, 0);
      const missingGpsRows = Math.max(0, collected.length - displayedSourceRows);
      const modeLabel = overlayDisplayMode === 'unique'
        ? 'Unique GPS locations · median RSRP'
        : overlayDisplayMode === 'individual'
          ? 'Individual measurements · selected identity'
          : `All imported records · RAT ${overlayRatFilter || 'All'} · PCI ${overlayPciFilter || 'All'} · ${overlayValidOnly ? 'valid RSRP' : 'all RF validity'}`;
      const identityLabel = profileMode && profile
        ? `${profile.rat} · PCI ${profile.pci} · band ${profile.band ?? '—'} · ARFCN ${profile.arfcn ?? '—'} · LTE anchor ${profile.lteAnchorCellId ?? '—'} / PCI ${profile.lteAnchorPci ?? '—'}`
        : dataset?.filename ?? 'Imported dataset';
      const label = `${modeLabel} · ${identityLabel}`;
      onShowMeasurementsIn3D(points, label);

      const modeSummary = overlayDisplayMode === 'unique'
        ? `${points.length.toLocaleString()} unique GPS locations from ${displayedSourceRows.toLocaleString()} valid measurements`
        : `${points.length.toLocaleString()} markers / ${displayedSourceRows.toLocaleString()} source records`;
      setMessage(`Sent ${modeSummary} to the 3D scene.${missingGpsRows ? ` Excluded ${missingGpsRows.toLocaleString()} rows without valid GPS coordinates.` : ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const exportLocationRayTraceCsv = () => {
    if (!raytraceResult) return;
    const columns = [
      'sampleIndex', 'firstTimestampUtc', 'lastTimestampUtc', 'latitude', 'longitude',
      'eastM', 'northM', 'rxHeightAglM', 'sourceRowCount', 'sourceRows',
      'measuredRsrpMedianDbm', 'measuredRsrqMedianDb', 'measuredSinrMedianDb',
      'simulatedTotalRxPowerDbm', 'simulatedChannelGainDb', 'losStatus', 'numPaths',
      'rmsDelaySpreadNs', 'strongestPathPowerDbm', 'strongestPathType', 'maxDopplerHz',
      'withinSceneEnvelope', 'simulationValid', 'configurationFingerprint',
      'effectiveFrequencyGhz', 'txPowerDbm', 'txPowerReference', 'txArraySize', 'txPattern',
      'txPolarization', 'rxArraySize', 'rxPattern', 'rxPolarization', 'beamAzimuthDeg',
      'beamElevationDeg', 'maxDepth', 'pathSamplesPerSource', 'pathSeed', 'sceneGeometryFingerprint',
    ];
    const cfg = raytraceResult.rfConfiguration;
    const quote = (value: unknown) => {
      const text = Array.isArray(value) ? value.join('|') : value == null ? '' : String(value);
      return `"${text.replace(/"/g, '""')}"`;
    };
    const rows = [columns.join(','), ...raytraceResult.results.map((row) => {
      const values: Record<string, unknown> = {
        ...row,
        effectiveFrequencyGhz: cfg.frequency.effectiveGhz,
        txPowerDbm: cfg.tx.powerDbm,
        txPowerReference: cfg.tx.powerReference,
        txArraySize: cfg.tx.arraySize,
        txPattern: cfg.tx.pattern,
        txPolarization: cfg.tx.polarization,
        rxArraySize: cfg.rx.arraySize,
        rxPattern: cfg.rx.pattern,
        rxPolarization: cfg.rx.polarization,
        beamAzimuthDeg: cfg.tx.beamAzimuthDeg,
        beamElevationDeg: cfg.tx.beamElevationDeg,
        maxDepth: cfg.pathSolver.maxDepth,
        pathSamplesPerSource: cfg.pathSolver.pathSamplesPerSource,
        pathSeed: cfg.pathSolver.pathSeed,
        sceneGeometryFingerprint: cfg.scene.geometryFingerprint,
      };
      return columns.map((key) => quote(values[key])).join(',');
    })];
    const blob = new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url;
    link.download = `measurement_raytrace_${raytraceResult.transmitter.txId}_pci${raytraceResult.profile.pci}_samples.csv`;
    link.click(); URL.revokeObjectURL(url);
  };

  const exportRayTraceConfigJson = () => {
    if (!raytraceResult) return;
    const payload = {
      datasetId: raytraceResult.datasetId,
      measurementFile: raytraceResult.filename,
      profile: raytraceResult.profile,
      transmitter: raytraceResult.transmitter,
      rfConfiguration: raytraceResult.rfConfiguration,
      configurationFingerprint: raytraceResult.configurationFingerprint,
      sampleCountReturned: raytraceResult.sampleCountReturned,
      validSimulationCount: raytraceResult.validSimulationCount,
      noPathCount: raytraceResult.noPathCount,
      medianSimulatedTotalRxPowerDbm: raytraceResult.medianSimulatedTotalRxPowerDbm,
      medianSimulatedChannelGainDb: raytraceResult.medianSimulatedChannelGainDb,
      warnings: raytraceResult.warnings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url;
    link.download = `measurement_raytrace_${raytraceResult.transmitter.txId}_rf_config.json`;
    link.click(); URL.revokeObjectURL(url);
  };

  const summary = dataset?.summary;
  const pciOptions = useMemo(() => summary?.pciCounts ?? [], [summary]);
  const geoAuditMatchesCurrentScene = Boolean(geoAudit
    && Math.abs(geoAudit.anchor.latitude - anchor.latitude) < 1e-10
    && Math.abs(geoAudit.anchor.longitude - anchor.longitude) < 1e-10
    && ((geoAudit.sceneBounds == null && sceneBounds == null)
      || (geoAudit.sceneBounds != null && sceneBounds != null
        && Math.abs(geoAudit.sceneBounds.xMin - sceneBounds.xMin) < 1e-6
        && Math.abs(geoAudit.sceneBounds.xMax - sceneBounds.xMax) < 1e-6
        && Math.abs(geoAudit.sceneBounds.yMin - sceneBounds.yMin) < 1e-6
        && Math.abs(geoAudit.sceneBounds.yMax - sceneBounds.yMax) < 1e-6)));
  const matchingAuditMatchesCurrentScene = Boolean(matchingAudit
    && matchingAudit.anchor
    && Math.abs(matchingAudit.anchor.latitude - anchor.latitude) < 1e-10
    && Math.abs(matchingAudit.anchor.longitude - anchor.longitude) < 1e-10
    && ((matchingAudit.sceneBounds == null && sceneBounds == null)
      || (matchingAudit.sceneBounds != null && sceneBounds != null
        && Math.abs(matchingAudit.sceneBounds.xMin - sceneBounds.xMin) < 1e-6
        && Math.abs(matchingAudit.sceneBounds.xMax - sceneBounds.xMax) < 1e-6
        && Math.abs(matchingAudit.sceneBounds.yMin - sceneBounds.yMin) < 1e-6
        && Math.abs(matchingAudit.sceneBounds.yMax - sceneBounds.yMax) < 1e-6))
    && matchingAudit.candidateTransmitters.length === Math.min(transmitters.length, 128)
    && matchingAudit.candidateTransmitters.every((candidate) => {
      const current = transmitters.find((txItem) => txItem.id === candidate.txId);
      return Boolean(current && candidate.txEastM != null && candidate.txNorthM != null
        && Math.abs(current.enu.x - candidate.txEastM) < 1e-6
        && Math.abs(current.enu.y - candidate.txNorthM) < 1e-6
        && (candidate.beamAzimuthDeg == null || Math.abs(current.beamsteeringAzimuth - candidate.beamAzimuthDeg) < 1e-6)
        && (current.frequencyBand ?? null) === (candidate.frequencyBand ?? null)
        && (current.carrierFrequencyGhz ?? null) === (candidate.carrierFrequencyGhz ?? null));
    }));

  const preview = rows?.rows ?? (dataset?.preview ?? []).map((raw, index) => ({
    rowIndex: index,
    raw: raw as Record<string, string>,
    quality: {
      timestampUtc: null, rat: String(raw.rat ?? '') || null,
      pci: raw.pci == null ? null : Number(raw.pci),
      rsrpDbm: null, rsrqDb: null, sinrDb: null, rssiDbm: null, lat: null, lon: null,
      radioValid: Boolean(raw.radioValid), locationValid: Boolean(raw.locationValid),
      eligibleForSpatialValidation: Boolean(raw.eligibleForSpatialValidation),
      qualityFlags: Array.isArray(raw.qualityFlags) ? raw.qualityFlags as string[] : [],
    },
  }));

  return (
    <div className="panel p-5 flex flex-col gap-5 h-full overflow-y-auto" id="field-validation-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-3">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="w-5 h-5 text-[var(--accent)]" />
          <div>
            <h3 className="panel-title">Field Measurement Validation</h3>
            <p className="text-xs text-[var(--text-lo)]">Field Data Import, Quality Control, Geospatial Alignment, and Radio Identity</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void uploadFile(e.target.files?.[0])} />
          <button className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-2" type="button" disabled={!backendOnline || busy !== null} onClick={() => fileRef.current?.click()}>
            {busy === 'upload' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Import CSV
          </button>
          <button className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--text-hi)] hover:bg-[var(--page)] disabled:opacity-50 flex items-center gap-2" type="button" disabled={!backendOnline || busy !== null} onClick={() => void refreshDatasets()}>
            <RefreshCw className={`w-4 h-4 ${busy === 'list' ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {!backendOnline && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Backend is unavailable. Start the SionnaRTStudio backend before importing data.</div>}
      {error && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
      {message && <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">{message}</div>}

      <div className="rounded-lg border border-[var(--line)] p-3 flex flex-col md:flex-row md:items-center gap-3">
        <div className="flex items-center gap-2 text-sm font-medium"><Database className="w-4 h-4 text-[var(--accent)]" /> Imported datasets</div>
        <select className="flex-1 min-w-0 rounded-md border border-[var(--line)] bg-[var(--page)] px-3 py-2 text-sm text-[var(--text-hi)]" value={selectedId} onChange={(e) => void loadDataset(e.target.value)} disabled={busy !== null || datasets.length === 0}>
          {datasets.length === 0 && <option value="">No imported datasets</option>}
          {datasets.map((item) => <option key={item.datasetId} value={item.datasetId}>{item.filename} · {item.totalRows.toLocaleString()} rows</option>)}
        </select>
        <span className="text-xs text-[var(--text-lo)]">Up to 8 datasets stored in memory</span>
      </div>

      {busy === 'load' && <div className="flex items-center gap-2 text-sm text-[var(--text-lo)]"><Loader2 className="w-4 h-4 animate-spin" /> Loading dataset…</div>}

      {summary && dataset && <>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <StatCard label="Total records" value={summary.totalRows.toLocaleString()} detail={`${summary.columnCount} CSV columns`} />
          <StatCard label="Valid RSRP" value={summary.radioValidRows.toLocaleString()} detail={`${summary.radioInvalidRows} invalid / missing`} />
          <StatCard label="GPS coverage" value={`${fmt(summary.gpsCoveragePercent, 1)}%`} detail={`${summary.locationValidRows.toLocaleString()} coordinates`} />
          <StatCard label="Eligible for spatial validation" value={summary.eligibleForSpatialValidationRows.toLocaleString()} detail="Valid RSRP + GPS + timestamp" />
        </div>

        <section className="flex flex-col gap-2">
          <h4 className="eyebrow">Dataset metadata</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm rounded-lg border border-[var(--line)] p-3">
            <div><span className="text-[var(--text-lo)]">UTC period:</span><div className="font-mono">{fmtDate(summary.timestampStartUtc)} → {fmtDate(summary.timestampEndUtc)}</div></div>
            <div><span className="text-[var(--text-lo)]">Duration:</span><div className="font-mono">{summary.durationSeconds == null ? '—' : `${fmt(summary.durationSeconds / 60, 1)} min`}</div></div>
            <div><span className="text-[var(--text-lo)]">RAT:</span><div>{summary.ratCounts.map((x) => `${x.rat}: ${x.count}`).join(' · ') || '—'}</div></div>
            <div><span className="text-[var(--text-lo)]">Band / ARFCN:</span><div>{summary.bandCounts.map((x) => `B${x.band} (${x.count})`).join(' · ') || '—'} / {summary.arfcnCounts.map((x) => `${x.arfcn} (${x.count})`).join(' · ') || '—'}</div></div>
            <div><span className="text-[var(--text-lo)]">WGS84 latitude:</span><div className="font-mono">{summary.latitudeBounds ? `${fmt(summary.latitudeBounds.min, 6)} … ${fmt(summary.latitudeBounds.max, 6)}` : '—'}</div></div>
            <div><span className="text-[var(--text-lo)]">WGS84 longitude:</span><div className="font-mono">{summary.longitudeBounds ? `${fmt(summary.longitudeBounds.min, 6)} … ${fmt(summary.longitudeBounds.max, 6)}` : '—'}</div></div>
            <div><span className="text-[var(--text-lo)]">Duplicate timestamp groups / extra rows:</span><div className="font-mono">{summary.duplicateTimestampGroups} / {summary.duplicateTimestampExtraRows}</div></div>
            <div><span className="text-[var(--text-lo)]">GPS position source:</span><div>{summary.positionSources.map((x) => `${x.source}: ${x.count}`).join(' · ') || 'Unspecified'}</div></div>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h4 className="eyebrow">RF measurement statistics</h4>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <StatCard label="NR RSRP median" value={summary.rsrpNrValid ? `${fmt(summary.rsrpNrValid.median)} dBm` : '—'} detail={summary.rsrpNrValid ? `N=${summary.rsrpNrValid.count} · P05 ${fmt(summary.rsrpNrValid.p05)} · P95 ${fmt(summary.rsrpNrValid.p95)}` : undefined} />
            <StatCard label="NR RSRQ median" value={summary.rsrqNrValid ? `${fmt(summary.rsrqNrValid.median)} dB` : '—'} detail={summary.rsrqNrValid ? `N=${summary.rsrqNrValid.count} · mean ${fmt(summary.rsrqNrValid.mean)}` : undefined} />
            <StatCard label="NR SINR median" value={summary.sinrNrValid ? `${fmt(summary.sinrNrValid.median)} dB` : '—'} detail={summary.sinrNrValid ? `N=${summary.sinrNrValid.count} · mean ${fmt(summary.sinrNrValid.mean)}` : undefined} />
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2"><h4 className="eyebrow">PCI distribution</h4><span className="text-xs text-[var(--text-lo)]">{summary.uniquePciCount} unique PCI values</span></div>
          <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--page)] text-[var(--text-lo)]"><tr><th className="text-left p-2">PCI</th><th className="text-right p-2">Samples</th><th className="text-right p-2">Share</th></tr></thead>
              <tbody>{summary.pciCounts.map((item) => <tr key={item.pci} className="border-t border-[var(--line)]"><td className="p-2 font-mono">{item.pci}</td><td className="p-2 text-right font-mono">{item.count.toLocaleString()}</td><td className="p-2 text-right font-mono">{fmt(100 * item.count / summary.totalRows, 1)}%</td></tr>)}</tbody>
            </table>
          </div>
        </section>

        {summary.warnings.length > 0 && <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 flex flex-col gap-2">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="w-4 h-4" /> Quality-control warnings</div>
          {summary.warnings.map((warning, i) => <p key={i}>• {warning}</p>)}
        </section>}

        <section className="flex flex-col gap-3 rounded-lg border border-[var(--line)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><Globe2 className="w-4 h-4 text-[var(--accent)]"/><h4 className="eyebrow">Geospatial Alignment Audit</h4></div>
            <button className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-2" type="button" disabled={busy !== null || !selectedId || summary.locationValidRows === 0} onClick={() => void runGeospatialAudit()}>
              {busy === 'georef' ? <Loader2 className="w-4 h-4 animate-spin"/> : <Crosshair className="w-4 h-4"/>}
              Run geospatial audit
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm rounded-lg bg-[var(--page)] p-3">
            <div><span className="text-[var(--text-lo)]">Measurement coordinate assumption:</span><div className="font-mono">WGS84 · EPSG:4326</div><p className="text-[10px] text-[var(--text-lo)]">Assumed from latitude/longitude fields; original track metadata is unavailable.</p></div>
            <div><span className="text-[var(--text-lo)]">Active scene anchor:</span><div className="font-mono">{fmt(anchor.latitude, 7)}, {fmt(anchor.longitude, 7)}</div></div>
            <div><span className="text-[var(--text-lo)]">Scene coordinates:</span><div className="font-mono">WGS84 local tangent ENU</div></div>
            <div><span className="text-[var(--text-lo)]">Metric reference projection:</span><div className="font-mono">EPSG:32634 · UTM 34N</div></div>
            <div className="md:col-span-2"><span className="text-[var(--text-lo)]">Active scene geometry envelope (ENU metres):</span><div className="font-mono">{sceneBounds ? `E ${fmt(sceneBounds.xMin, 1)} … ${fmt(sceneBounds.xMax, 1)} m · N ${fmt(sceneBounds.yMin, 1)} … ${fmt(sceneBounds.yMax, 1)} m` : 'No geometry with ENU coordinates — load OSM/scene geometry.'}</div></div>
          </div>
          {geoAudit && <>
            {!geoAuditMatchesCurrentScene && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">Scene anchor or geometry has changed since this audit. Run the geospatial audit again before exporting or using these coordinates.</div>}
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
              <StatCard label="GPS → ENU transformed" value={geoAudit.locationRows.toLocaleString()} detail={`${geoAudit.distinctGpsPositions.toLocaleString()} unique GPS positions`} />
              <StatCard label="Within scene envelope" value={geoAudit.withinSceneEnvelopeRows == null ? '—' : geoAudit.withinSceneEnvelopeRows.toLocaleString()} detail={geoAudit.outsideSceneEnvelopeRows == null ? 'Scene bounds are unavailable' : `${geoAudit.outsideSceneEnvelopeRows.toLocaleString()} outside the envelope`} />
              <StatCard label="Eligible & inside" value={geoAudit.withinSceneEnvelopeEligibleRows == null ? '—' : geoAudit.withinSceneEnvelopeEligibleRows.toLocaleString()} detail={`${geoAudit.eligibleForSpatialValidationRows.toLocaleString()} eligible RF, GPS, and timestamp records`} />
              <StatCard label="Track centroid ↔ anchor" value={geoAudit.gpsCentroidDistanceFromAnchorM == null ? '—' : `${fmt(geoAudit.gpsCentroidDistanceFromAnchorM, 1)} m`} detail="Distance from route centroid to scene origin" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-lg border border-[var(--line)] p-3 text-sm">
              <div><span className="text-[var(--text-lo)]">Measured track ENU extent:</span><div className="font-mono">{geoAudit.sceneEnuBoundsOfMeasurements ? `E ${fmt(geoAudit.sceneEnuBoundsOfMeasurements.eastMinM, 1)} … ${fmt(geoAudit.sceneEnuBoundsOfMeasurements.eastMaxM, 1)} m · N ${fmt(geoAudit.sceneEnuBoundsOfMeasurements.northMinM, 1)} … ${fmt(geoAudit.sceneEnuBoundsOfMeasurements.northMaxM, 1)} m` : '—'}</div></div>
              <div><span className="text-[var(--text-lo)]">UTM 34N bounds:</span><div className="font-mono">{geoAudit.utm34nBounds ? `E ${fmt(geoAudit.utm34nBounds.eastingMinM, 1)} … ${fmt(geoAudit.utm34nBounds.eastingMaxM, 1)} m · N ${fmt(geoAudit.utm34nBounds.northingMinM, 1)} … ${fmt(geoAudit.utm34nBounds.northingMaxM, 1)} m` : '—'}</div><p className="text-[10px] text-[var(--text-lo)]">UTM is an independent metric reference; scene solver still uses local ENU.</p></div>
              <div><span className="text-[var(--text-lo)]">Scene anchor inside geometry envelope:</span><div className="font-mono">{geoAudit.anchorInsideSceneEnvelope == null ? 'Not evaluated' : geoAudit.anchorInsideSceneEnvelope ? 'Yes' : 'No — verify anchor and scene alignment'}</div></div>
              <div><span className="text-[var(--text-lo)]">GPS altitude range:</span><div className="font-mono">{geoAudit.gpsAltitudeStatsM ? `${fmt(geoAudit.gpsAltitudeStatsM.min, 1)} … ${fmt(geoAudit.gpsAltitudeStatsM.max, 1)} m` : '—'}</div><p className="text-[10px] text-[var(--text-lo)]">GPS altitude is not converted to scene Z until its vertical datum is confirmed.</p></div>
            </div>
            {geoAudit.warnings.length > 0 && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 flex flex-col gap-1"><strong>Georeference warnings / caveats</strong>{geoAudit.warnings.map((warning, i) => <p key={i}>• {warning}</p>)}</div>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] text-[var(--text-lo)]">The ENU transform uses the same WGS84 local-tangent method as the Studio. The inside/outside check uses the rectangular geometry envelope, not an exact mesh-containment test.</p>
              <button className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--text-hi)] hover:bg-[var(--page)] disabled:opacity-50 flex items-center gap-2" type="button" disabled={busy !== null || !geoAuditMatchesCurrentScene} onClick={() => void downloadGeoreferencedExport()}><Download className="w-4 h-4"/> Export georeferenced CSV</button>
            </div>
          </>}
        </section>

        <section className="flex flex-col gap-3 rounded-lg border border-[var(--line)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><Crosshair className="w-4 h-4 text-[var(--accent)]"/><h4 className="eyebrow">Radio Identity &amp; Transmitter Matching</h4></div>
            <button className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-2" type="button" disabled={busy !== null || !selectedId || summary.eligibleForSpatialValidationRows === 0} onClick={() => void runRadioIdentityAudit()}>
              {busy === 'matching' ? <Loader2 className="w-4 h-4 animate-spin"/> : <Crosshair className="w-4 h-4"/>}
              Run identity matching audit
            </button>
          </div>
          <p className="text-xs text-[var(--text-lo)]">Profiles RAT/PCI/band/ARFCN and LTE-anchor contexts. TX candidates are ranked using active ENU positions and antenna boresight azimuths. This supports manual review; it does not automatically identify the operator serving site.</p>
          <div className="rounded-lg border border-[var(--line)] bg-[var(--page)] p-3 flex flex-col gap-3">
            <div>
              <div className="text-sm font-semibold text-[var(--text-hi)]">Field Measurements in the 3D Scene</div>
              <p className="text-xs text-[var(--text-lo)] mt-1">Choose a display mode. The selected-profile modes use the exact RAT/PCI/band/ARFCN and LTE-anchor context; the all-records mode displays every row with GPS coordinates.</p>
              <p className="text-[10px] text-amber-800 mt-1">GPS altitude is not used. Records at the same position retain identical geographic coordinates; hovering over a marker reveals every record at that location.</p>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
              <label className="text-xs flex flex-col gap-1">Display mode
                <select className="rounded-md border border-[var(--line)] bg-white px-2 py-2 text-sm text-slate-800" value={overlayDisplayMode} onChange={(e) => setOverlayDisplayMode(e.target.value as 'unique' | 'individual' | 'all_records')} disabled={busy !== null}>
                  <option value="unique">1. Unique GPS locations (grouped)</option>
                  <option value="individual">2. All individual measurements in the selected profile</option>
                  <option value="all_records">3. All imported records</option>
                </select>
              </label>
              {overlayDisplayMode === 'all_records' ? <>
                <label className="text-xs flex flex-col gap-1">RAT filter
                  <select className="rounded-md border border-[var(--line)] bg-white px-2 py-2 text-sm text-slate-800" value={overlayRatFilter} onChange={(e) => setOverlayRatFilter(e.target.value)} disabled={busy !== null}>
                    <option value="">All RAT types</option>
                    {(summary?.ratCounts ?? []).map((item) => <option key={item.rat} value={item.rat}>{item.rat} ({item.count})</option>)}
                  </select>
                </label>
                <label className="text-xs flex flex-col gap-1">PCI filter
                  <select className="rounded-md border border-[var(--line)] bg-white px-2 py-2 text-sm text-slate-800" value={overlayPciFilter} onChange={(e) => setOverlayPciFilter(e.target.value)} disabled={busy !== null}>
                    <option value="">All PCIs</option>
                    {(summary?.pciCounts ?? []).map((item) => <option key={item.pci} value={item.pci}>{item.pci} ({item.count})</option>)}
                  </select>
                </label>
              </> : <div className="rounded-lg bg-white p-3 text-xs text-slate-600 flex items-center">The selected radio identity profile defines the RAT, PCI, band, ARFCN, and LTE anchor.</div>}
            </div>
            {overlayDisplayMode === 'all_records' && <label className="flex items-center gap-2 text-xs text-[var(--text-hi)]"><input type="checkbox" checked={overlayValidOnly} onChange={(e) => setOverlayValidOnly(e.target.checked)} disabled={busy !== null} /> Show only records with valid RSRP <span className="text-[var(--text-lo)]">(excludes RF records flagged as invalid by QC)</span></label>}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-[var(--text-lo)]">
                {overlayDisplayMode === 'unique' && matchingAudit?.selectedProfile
                  ? `Expected: ${matchingAudit.selectedProfile.distinctGpsPositions.toLocaleString()} locations · ${matchingAudit.selectedProfile.eligibleRows.toLocaleString()} valid records.`
                  : overlayDisplayMode === 'individual' && matchingAudit?.selectedProfile
                    ? `The profile contains ${matchingAudit.selectedProfile.eligibleRows.toLocaleString()} valid RF/GPS measurements.`
                    : overlayDisplayMode === 'all_records' && summary
                      ? `Dataset: ${summary.totalRows.toLocaleString()} rows · ${summary.locationValidRows.toLocaleString()} with GPS · ${summary.radioInvalidRows.toLocaleString()} RF-invalid.`
                      : 'Run the radio identity audit first to use display modes 1 and 2.'}
              </div>
              <button type="button" onClick={() => void showMeasurementsIn3D()} disabled={busy !== null || !selectedId || (overlayDisplayMode !== 'all_records' && (!matchingAudit?.selectedProfile || !matchingAuditMatchesCurrentScene))} className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-2 whitespace-nowrap">
                {busy === 'overlay' ? <Loader2 className="w-4 h-4 animate-spin"/> : <MapPin className="w-4 h-4"/>}
                {busy === 'overlay' ? 'Preparing records…' : overlayDisplayMode === 'unique'
                  ? `Show ${matchingAudit?.selectedProfile?.distinctGpsPositions.toLocaleString() ?? '—'} locations in 3D`
                  : overlayDisplayMode === 'individual'
                    ? `Show ${matchingAudit?.selectedProfile?.eligibleRows.toLocaleString() ?? '—'} measurements in 3D`
                    : 'Show filtered records in 3D'}
              </button>
            </div>
          </div>
          {matchingAudit && <>
            {!matchingAuditMatchesCurrentScene && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">The scene anchor, geometry, or TX configuration changed after the matching audit. Run the audit again before using the candidates.</div>}
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
              <StatCard label="Radio identity contexts" value={matchingAudit.totalIdentityProfiles?.toLocaleString() ?? matchingAudit.identityProfiles.length.toLocaleString()} detail="NR/LTE + carrier + anchor context" />
              <StatCard label="Selected context rows" value={matchingAudit.selectedProfile?.rowCount.toLocaleString() ?? '—'} detail={`${matchingAudit.selectedProfile?.eligibleRows.toLocaleString() ?? '0'} valid RF/GPS records`} />
              <StatCard label="Distinct GPS positions" value={matchingAudit.selectedProfile?.distinctGpsPositions.toLocaleString() ?? '—'} detail="In the selected radio context" />
              <StatCard label="Scene TX candidates" value={matchingAudit.candidateTransmitters.length.toLocaleString()} detail={`${transmitters.length} active TX devices in the project`} />
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <label className="text-xs flex flex-col gap-1">Radio identity context
                <select className="rounded-md border border-[var(--line)] bg-[var(--page)] px-2 py-2 text-sm text-[var(--text-hi)]" value={selectedProfileId} onChange={(e) => { setSelectedProfileId(e.target.value); void runRadioIdentityAudit(e.target.value); }} disabled={busy !== null || matchingAudit.identityProfiles.length === 0}>
                  {matchingAudit.identityProfiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.rat} · PCI {profile.pci} · B{profile.band ?? '—'} / ARFCN {profile.arfcn ?? '—'} · LTE anchor {profile.lteAnchorCellId ?? '—'} / PCI {profile.lteAnchorPci ?? '—'} · N={profile.rowCount}</option>)}
                </select>
              </label>
              <div className="rounded-lg bg-[var(--page)] p-3 text-sm">
                <div className="eyebrow text-[var(--text-lo)]">Selected measured context</div>
                {matchingAudit.selectedProfile ? <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
                  <span>RAT: {matchingAudit.selectedProfile.rat}</span><span>PCI: {matchingAudit.selectedProfile.pci}</span><span>Band: {matchingAudit.selectedProfile.band ?? '—'}</span><span>NR ARFCN: {matchingAudit.selectedProfile.arfcn ?? '—'}</span>
                  <span>LTE anchor Cell ID: {matchingAudit.selectedProfile.lteAnchorCellId ?? '—'}</span><span>LTE anchor PCI: {matchingAudit.selectedProfile.lteAnchorPci ?? '—'}</span>
                </div> : <p className="text-xs text-[var(--text-lo)]">No identities match the current filter.</p>}
              </div>
            </div>
            {matchingAudit.selectedProfile && <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <StatCard label="Measured RSRP median" value={matchingAudit.selectedProfile.rsrpMedianDbm == null ? '—' : `${fmt(matchingAudit.selectedProfile.rsrpMedianDbm)} dBm`} detail={`P05 ${fmt(matchingAudit.selectedProfile.rsrpP05Dbm)} · P95 ${fmt(matchingAudit.selectedProfile.rsrpP95Dbm)}`} />
              <StatCard label="Measured SINR median" value={matchingAudit.selectedProfile.sinrMedianDb == null ? '—' : `${fmt(matchingAudit.selectedProfile.sinrMedianDb)} dB`} detail="Valid SINR values only" />
              <StatCard label="Measurement period" value={matchingAudit.selectedProfile.firstTimestampUtc ? new Date(matchingAudit.selectedProfile.firstTimestampUtc).toLocaleDateString() : '—'} detail={`${fmtDate(matchingAudit.selectedProfile.firstTimestampUtc)} → ${fmtDate(matchingAudit.selectedProfile.lastTimestampUtc)}`} />
            </div>}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2"><h5 className="eyebrow">Candidate transmitters — distance &amp; sector orientation</h5><span className="text-xs text-[var(--text-lo)]">Heuristic ranking only</span></div>
              {matchingAudit.candidateTransmitters.length > 0 ? <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
                <table className="w-full text-xs min-w-[780px]">
                  <thead className="bg-[var(--page)] text-[var(--text-lo)]"><tr>{['Candidate TX','Band match','Median distance','P90 distance','Track bearing','TX beam azimuth','Angular difference'].map((x) => <th key={x} className="text-left p-2 whitespace-nowrap">{x}</th>)}</tr></thead>
                  <tbody>{matchingAudit.candidateTransmitters.map((candidate, index) => <tr key={candidate.txId} className="border-t border-[var(--line)]">
                    <td className="p-2"><div className="font-medium">{index + 1}. {candidate.txName}</div><div className="text-[var(--text-lo)]">{candidate.site || candidate.txId}</div></td>
                    <td className="p-2">{candidate.frequencyBandMatch == null ? <span className="text-[var(--text-lo)]">Unknown</span> : candidate.frequencyBandMatch ? <span className="text-emerald-700">Match</span> : <span className="text-amber-700">Mismatch</span>}</td>
                    <td className="p-2 font-mono">{candidate.distanceP50M == null ? '—' : `${fmt(candidate.distanceP50M, 1)} m`}</td>
                    <td className="p-2 font-mono">{candidate.distanceP90M == null ? '—' : `${fmt(candidate.distanceP90M, 1)} m`}</td>
                    <td className="p-2 font-mono">{candidate.measurementBearingMeanDeg == null ? '—' : `${fmt(candidate.measurementBearingMeanDeg, 1)}°`}</td>
                    <td className="p-2 font-mono">{candidate.beamAzimuthDeg == null ? '—' : `${fmt(candidate.beamAzimuthDeg, 1)}°`}</td>
                    <td className="p-2 font-mono">{candidate.boresightDeltaDeg == null ? '—' : `${fmt(candidate.boresightDeltaDeg, 1)}°`}</td>
                  </tr>)}</tbody>
                </table>
              </div> : <div className="rounded-lg border border-dashed border-[var(--line)] p-4 text-sm text-[var(--text-lo)]">No active TX devices with ENU coordinates are available for candidate analysis.</div>}
            </div>
            {matchingAudit.selectedProfile && matchingAudit.candidateTransmitters.length > 0 && <section className="rounded-lg border border-[var(--line)] p-3 flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h5 className="eyebrow">Measurement-Location Ray Tracing</h5><p className="text-xs text-[var(--text-lo)] mt-1">Downlink BS → UE. Sampled GPS locations are converted to ENU coordinates and processed in a single batched PathSolver call.</p></div>
                <span className="text-xs text-[var(--text-lo)]">PCI-to-TX mapping is not automatic</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <label className="text-xs flex flex-col gap-1">TX candidate
                  <select className="rounded-md border border-[var(--line)] bg-[var(--page)] px-2 py-2 text-sm text-[var(--text-hi)]" value={raytraceTxId} onChange={(e) => { setRaytraceTxId(e.target.value); setRaytraceResult(null); }} disabled={busy !== null}>
                    {matchingAudit.candidateTransmitters.map((candidate) => <option key={candidate.txId} value={candidate.txId}>{candidate.txName} · P50 {candidate.distanceP50M == null ? '—' : `${fmt(candidate.distanceP50M, 0)} m`} · Δ {candidate.boresightDeltaDeg == null ? '—' : `${fmt(candidate.boresightDeltaDeg, 1)}°`}</option>)}
                  </select>
                </label>
                <label className="text-xs flex flex-col gap-1">Number of locations
                  <select className="rounded-md border border-[var(--line)] bg-[var(--page)] px-2 py-2 text-sm text-[var(--text-hi)]" value={raytraceSampleCount} onChange={(e) => { setRaytraceSampleCount(Number(e.target.value)); setRaytraceResult(null); }} disabled={busy !== null}>
                    <option value={25}>25 — quick test</option><option value={50}>50 — extended test</option><option value={100}>100 — large test</option>
                  </select>
                </label>
                <label className="text-xs flex flex-col gap-1">UE height AGL (m)
                  <input type="number" min="0.2" max="10" step="0.1" value={raytraceRxHeight} onChange={(e) => { setRaytraceRxHeight(Number(e.target.value)); setRaytraceResult(null); }} className="rounded-md border border-[var(--line)] bg-[var(--page)] px-2 py-2 text-sm text-[var(--text-hi)]" disabled={busy !== null}/>
                </label>
                <label className="text-xs flex flex-col gap-1">PathSolver max depth
                  <select className="rounded-md border border-[var(--line)] bg-[var(--page)] px-2 py-2 text-sm text-[var(--text-hi)]" value={raytraceMaxDepth} onChange={(e) => { setRaytraceMaxDepth(Number(e.target.value)); setRaytraceResult(null); }} disabled={busy !== null}>
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((v) => <option key={v} value={v}>{v} {v === 0 ? '— LOS only' : ''}</option>)}
                  </select>
                </label>
                <label className="text-xs flex flex-col gap-1">Path samples / source
                  <select className="rounded-md border border-[var(--line)] bg-[var(--page)] px-2 py-2 text-sm text-[var(--text-hi)]" value={raytracePathSamples} onChange={(e) => { setRaytracePathSamples(Number(e.target.value)); setRaytraceResult(null); }} disabled={busy !== null}>
                    {[10000, 100000, 500000, 1000000, 2000000, 5000000, 10000000].map((v) => <option key={v} value={v}>{v.toLocaleString()}</option>)}
                  </select>
                </label>
                <label className="text-xs flex flex-col gap-1">Path seed
                  <input type="number" min="0" max="2147483647" step="1" value={raytracePathSeed} onChange={(e) => { setRaytracePathSeed(Number(e.target.value)); setRaytraceResult(null); }} className="rounded-md border border-[var(--line)] bg-[var(--page)] px-2 py-2 text-sm text-[var(--text-hi)]" disabled={busy !== null}/>
                </label>
              </div>
              <p className="text-[11px] text-[var(--text-lo)]">Depth, samples per source, and seed are recorded for this run. For a convergence comparison, keep the dataset, TX, sampled GPS locations, UE height, antennas, materials, and seed fixed; change only one solver setting at a time.</p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void runLocationRayTrace()} disabled={!backendOnline || busy !== null || !matchingAuditMatchesCurrentScene || !raytraceTxId || !Number.isFinite(raytraceRxHeight) || raytraceRxHeight < 0.2 || raytraceRxHeight > 10 || !Number.isInteger(raytracePathSeed) || raytracePathSeed < 0 || raytracePathSeed > 2147483647} className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 flex items-center gap-2">
                  {busy === 'raytrace' ? <Loader2 className="w-4 h-4 animate-spin"/> : <Crosshair className="w-4 h-4"/>} Run sampled Sionna RT
                </button>
                {raytraceJobId && <button type="button" onClick={() => void cancelLocationRayTrace()} className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800 flex items-center gap-2"><Square className="w-3 h-3"/> Cancel job</button>}
                {raytraceResult && <>
                  <button type="button" onClick={exportLocationRayTraceCsv} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--text-hi)] flex items-center gap-2"><Download className="w-4 h-4"/> Export ray-trace CSV</button>
                  <button type="button" onClick={exportRayTraceConfigJson} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--text-hi)] flex items-center gap-2"><FileSpreadsheet className="w-4 h-4"/> Export RF config JSON</button>
                </>}
              </div>
              {raytraceJobId && <div className="w-full rounded-md bg-[var(--page)] p-2 text-xs text-[var(--text-lo)]"><div className="flex justify-between"><span>Ray-tracing progress</span><span>{Math.round(raytraceProgress * 100)}%</span></div><div className="mt-1 h-1.5 overflow-hidden rounded bg-[var(--line)]"><div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${Math.max(0, Math.min(1, raytraceProgress)) * 100}%` }}/></div></div>}
              {!matchingAuditMatchesCurrentScene && <p className="text-xs text-amber-800">Run the radio identity audit again after changing the anchor, scene bounds, or TX configuration.</p>}
              {raytraceResult && <>
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                  <StatCard label="Ray-traced locations" value={`${raytraceResult.validSimulationCount}/${raytraceResult.sampleCountReturned}`} detail={`${raytraceResult.noPathCount} locations with no path`}/>
                  <StatCard label="Median simulated total Rx" value={raytraceResult.medianSimulatedTotalRxPowerDbm == null ? '—' : `${fmt(raytraceResult.medianSimulatedTotalRxPowerDbm)} dBm`} detail="Total received power across all RT paths"/>
                  <StatCard label="Median channel gain" value={raytraceResult.medianSimulatedChannelGainDb == null ? '—' : `${fmt(raytraceResult.medianSimulatedChannelGainDb)} dB`} detail="Simulated total Rx minus TX power"/>
                  <StatCard label="Measured RSRP median" value={raytraceResult.medianMeasuredRsrpDbm == null ? '—' : `${fmt(raytraceResult.medianMeasuredRsrpDbm)} dBm`} detail="Separate modem SS-RSRP metric"/>
                </div>
                <div className="rounded-md bg-[var(--page)] p-3 text-xs flex flex-wrap gap-x-5 gap-y-1">
                  <span>TX: <strong>{raytraceResult.transmitter.txName}</strong></span><span>RT frequency: <strong>{fmt(raytraceResult.frequencyGhz, 5)} GHz</strong> ({raytraceResult.frequencySource})</span><span>NR-ARFCN: <strong>{raytraceResult.profile.arfcn ?? '—'}</strong></span><span>Depth: <strong>{raytraceResult.maxDepth}</strong></span><span>UE height: <strong>{fmt(raytraceResult.rxHeightAglM, 1)} m AGL</strong></span>
                </div>
                <div className="rounded-lg border border-[var(--line)] p-3 flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2"><h6 className="eyebrow">RF Configuration Snapshot</h6><span className={`text-[10px] font-semibold px-2 py-1 rounded ${raytraceResult.rfConfiguration.physicalCalibrationStatus === 'incomplete' ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-800'}`}>{raytraceResult.rfConfiguration.physicalCalibrationStatus}</span></div>
                  <div className="grid grid-cols-2 xl:grid-cols-4 gap-2 text-xs">
                    <div><span className="text-[var(--text-lo)]">TX power / reference</span><div className="font-mono font-semibold">{fmt(raytraceResult.rfConfiguration.tx.powerDbm, 1)} dBm / {raytraceResult.rfConfiguration.tx.powerReference ?? 'UNSPECIFIED'}</div></div>
                    <div><span className="text-[var(--text-lo)]">TX height resolution</span><div className="font-mono font-semibold">{raytraceResult.rfConfiguration.tx.heightResolution} · Z={fmt(raytraceResult.rfConfiguration.tx.positionEnuM.up, 2)} m</div></div>
                    <div><span className="text-[var(--text-lo)]">TX array / pattern / pol.</span><div className="font-mono font-semibold">{raytraceResult.rfConfiguration.tx.arraySize.join('×')} / {raytraceResult.rfConfiguration.tx.pattern} / {raytraceResult.rfConfiguration.tx.polarization}</div></div>
                    <div><span className="text-[var(--text-lo)]">RX array / pattern / pol.</span><div className="font-mono font-semibold">{raytraceResult.rfConfiguration.rx.arraySize.join('×')} / {raytraceResult.rfConfiguration.rx.pattern} / {raytraceResult.rfConfiguration.rx.polarization}</div></div>
                    <div><span className="text-[var(--text-lo)]">Beam azimuth / elevation</span><div className="font-mono font-semibold">{fmt(raytraceResult.rfConfiguration.tx.beamAzimuthDeg, 1)}° / {fmt(raytraceResult.rfConfiguration.tx.beamElevationDeg, 1)}°</div></div>
                    <div><span className="text-[var(--text-lo)]">PathSolver depth / samples</span><div className="font-mono font-semibold">{raytraceResult.rfConfiguration.pathSolver.maxDepth} / {raytraceResult.rfConfiguration.pathSolver.pathSamplesPerSource.toLocaleString()}</div></div>
                    <div><span className="text-[var(--text-lo)]">Seed / interactions</span><div className="font-mono font-semibold">{raytraceResult.rfConfiguration.pathSolver.pathSeed} / LOS {String(raytraceResult.rfConfiguration.pathSolver.los)}, spec {String(raytraceResult.rfConfiguration.pathSolver.specularReflection)}</div></div>
                    <div><span className="text-[var(--text-lo)]">Scene / materials</span><div className="font-mono font-semibold">{raytraceResult.rfConfiguration.scene.buildingCount} buildings / {raytraceResult.rfConfiguration.scene.materialOverrides.length} overrides</div></div>
                  </div>
                  <div className="text-[10px] text-[var(--text-lo)]">Antenna inventory: <span className="font-mono">{raytraceResult.rfConfiguration.tx.antennaModelMetadata ?? 'not specified'}</span> · gain metadata: <span className="font-mono">{raytraceResult.rfConfiguration.tx.antennaGainDbiMetadata == null ? 'not specified' : `${fmt(raytraceResult.rfConfiguration.tx.antennaGainDbiMetadata, 1)} dBi`}</span> · downtilt metadata applied automatically: <strong>No</strong></div>
                  <div className="text-[10px] text-[var(--text-lo)] break-all">Scene geometry fingerprint: <span className="font-mono">{raytraceResult.rfConfiguration.scene.geometryFingerprint}</span></div>
                  <div className="text-[10px] text-[var(--text-lo)] break-all">Configuration fingerprint: <span className="font-mono">{raytraceResult.configurationFingerprint}</span></div>
                  {raytraceResult.rfConfiguration.physicalCalibrationWarnings.map((warning, i) => <p key={i} className="text-xs text-amber-800">• {warning}</p>)}
                </div>
                <div className="overflow-x-auto rounded-lg border border-[var(--line)]"><table className="w-full text-xs min-w-[1050px]"><thead className="bg-[var(--page)] text-[var(--text-lo)]"><tr>{['#','UTC time','Measured RSRP','Simulated total Rx','Channel gain','LOS/NLOS','Paths','RMS delay','Latitude','Longitude'].map((x) => <th key={x} className="text-left p-2 whitespace-nowrap">{x}</th>)}</tr></thead><tbody>{raytraceResult.results.map((row) => <tr key={row.sampleIndex} className="border-t border-[var(--line)]"><td className="p-2 font-mono">{row.sampleIndex}</td><td className="p-2 font-mono whitespace-nowrap">{row.firstTimestampUtc ?? '—'}</td><td className="p-2 font-mono">{row.measuredRsrpMedianDbm == null ? '—' : `${fmt(row.measuredRsrpMedianDbm)} dBm`}</td><td className="p-2 font-mono">{row.simulatedTotalRxPowerDbm == null ? 'No path' : `${fmt(row.simulatedTotalRxPowerDbm)} dBm`}</td><td className="p-2 font-mono">{row.simulatedChannelGainDb == null ? '—' : `${fmt(row.simulatedChannelGainDb)} dB`}</td><td className="p-2">{row.numPaths ? row.losStatus : 'No path'}</td><td className="p-2 font-mono">{row.numPaths}</td><td className="p-2 font-mono">{fmt(row.rmsDelaySpreadNs, 1)} ns</td><td className="p-2 font-mono">{fmt(row.latitude, 6)}</td><td className="p-2 font-mono">{fmt(row.longitude, 6)}</td></tr>)}</tbody></table></div>
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 flex flex-col gap-1"><strong>Radiometric / model limitations</strong>{raytraceResult.warnings.map((warning, i) => <p key={i}>• {warning}</p>)}</div>
              </>}
            </section>}
            {matchingAudit.selectedProfile?.lteAnchorContexts && matchingAudit.selectedProfile.lteAnchorContexts.length > 0 && <div className="flex flex-col gap-2">
              <h5 className="eyebrow">LTE anchor contexts observed under this NR PCI</h5>
              <div className="overflow-x-auto rounded-lg border border-[var(--line)]"><table className="w-full text-xs"><thead className="bg-[var(--page)] text-[var(--text-lo)]"><tr><th className="text-left p-2">LTE Cell ID</th><th className="text-left p-2">LTE PCI</th><th className="text-left p-2">LTE EARFCN</th><th className="text-right p-2">Samples</th></tr></thead><tbody>{matchingAudit.selectedProfile.lteAnchorContexts.map((context, i) => <tr key={`${context.cellId}-${context.pci}-${context.earfcn}-${i}`} className="border-t border-[var(--line)]"><td className="p-2 font-mono">{context.cellId}</td><td className="p-2 font-mono">{context.pci ?? '—'}</td><td className="p-2 font-mono">{context.earfcn ?? '—'}</td><td className="p-2 text-right font-mono">{context.count.toLocaleString()}</td></tr>)}</tbody></table></div>
            </div>}
            {matchingAudit.preview.length > 0 && <div className="flex flex-col gap-2">
              <h5 className="eyebrow">Stratified measurement preview · selected context</h5>
              <div className="overflow-x-auto rounded-lg border border-[var(--line)]"><table className="w-full text-xs min-w-[760px]"><thead className="bg-[var(--page)] text-[var(--text-lo)]"><tr>{['Row','UTC timestamp','RSRP','RSRQ','SINR','Scene East','Scene North'].map((x) => <th key={x} className="text-left p-2">{x}</th>)}</tr></thead><tbody>{matchingAudit.preview.map((item, i) => <tr key={`${String(item.rowIndex ?? i)}-${i}`} className="border-t border-[var(--line)]"><td className="p-2 font-mono">{item.rowIndex == null ? '—' : Number(item.rowIndex) + 1}</td><td className="p-2 font-mono whitespace-nowrap">{String(item.timestampUtc ?? '—')}</td><td className="p-2 font-mono">{typeof item.rsrpDbm === 'number' ? `${fmt(item.rsrpDbm)} dBm` : '—'}</td><td className="p-2 font-mono">{typeof item.rsrqDb === 'number' ? `${fmt(item.rsrqDb)} dB` : '—'}</td><td className="p-2 font-mono">{typeof item.sinrDb === 'number' ? `${fmt(item.sinrDb)} dB` : '—'}</td><td className="p-2 font-mono">{typeof item.eastM === 'number' ? fmt(item.eastM, 2) : '—'}</td><td className="p-2 font-mono">{typeof item.northM === 'number' ? fmt(item.northM, 2) : '—'}</td></tr>)}</tbody></table></div>
            </div>}
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 flex flex-col gap-1"><strong>Interpretation / limitations</strong>{matchingAudit.warnings.map((warning, i) => <p key={i}>• {warning}</p>)}</div>
          </>}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="eyebrow">Record inspection</h4><span className="text-xs text-[var(--text-lo)]">First 100 filtered rows</span></div>
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--line)] p-3">
            <label className="text-xs flex flex-col gap-1">RAT<select className="rounded-md border border-[var(--line)] bg-[var(--page)] px-2 py-1.5 text-sm text-[var(--text-hi)]" value={ratFilter} onChange={(e) => setRatFilter(e.target.value)}><option value="">All</option>{summary.ratCounts.map((x) => <option key={x.rat} value={x.rat}>{x.rat}</option>)}</select></label>
            <label className="text-xs flex flex-col gap-1">PCI<select className="rounded-md border border-[var(--line)] bg-[var(--page)] px-2 py-1.5 text-sm text-[var(--text-hi)]" value={pciFilter} onChange={(e) => setPciFilter(e.target.value)}><option value="">All</option>{pciOptions.map((x) => <option key={x.pci} value={x.pci}>{x.pci} ({x.count})</option>)}</select></label>
            <label className="flex items-center gap-2 text-xs pb-2"><input type="checkbox" checked={validOnly} onChange={(e) => setValidOnly(e.target.checked)} /> Valid RSRP only</label>
            <label className="flex items-center gap-2 text-xs pb-2"><input type="checkbox" checked={spatialOnly} onChange={(e) => setSpatialOnly(e.target.checked)} /> Spatially eligible only</label>
            <button className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--text-hi)] hover:bg-[var(--page)] disabled:opacity-50 flex items-center gap-2" onClick={() => void runFilter()} disabled={busy !== null}><Filter className="w-4 h-4"/> Apply filters</button>
            <button className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--text-hi)] hover:bg-[var(--page)] disabled:opacity-50 flex items-center gap-2" onClick={() => void downloadExport()} disabled={busy !== null}><Download className="w-4 h-4"/> Export QC CSV</button>
          </div>
          {rows && <div className="text-xs text-[var(--text-lo)]">Showing {rows.rows.length} of {rows.total.toLocaleString()} records matching the filters.</div>}
          <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
            <table className="w-full text-xs min-w-[900px]">
              <thead className="bg-[var(--page)] text-[var(--text-lo)]"><tr>{['#','UTC timestamp','RAT','PCI','RSRP','RSRQ','SINR','Latitude','Longitude','QC'].map((x) => <th key={x} className="text-left p-2 whitespace-nowrap">{x}</th>)}</tr></thead>
              <tbody>{preview.map((item) => {
                const q = item.quality;
                const raw = item.raw;
                const get = (...keys: string[]) => { for (const key of keys) if (raw[key] != null && raw[key] !== '') return raw[key]; return '—'; };
                return <tr key={item.rowIndex} className="border-t border-[var(--line)]">
                  <td className="p-2 font-mono">{item.rowIndex + 1}</td><td className="p-2 font-mono whitespace-nowrap">{q.timestampUtc || get('timestamp_utc')}</td>
                  <td className="p-2">{q.rat || get('rat')}</td><td className="p-2 font-mono">{q.pci ?? get('pci')}</td>
                  <td className="p-2 font-mono">{q.rsrpDbm == null ? get('rsrp_dbm') : fmt(q.rsrpDbm)}</td><td className="p-2 font-mono">{q.rsrqDb == null ? get('rsrq_db') : fmt(q.rsrqDb)}</td><td className="p-2 font-mono">{q.sinrDb == null ? get('sinr_db') : fmt(q.sinrDb)}</td>
                  <td className="p-2 font-mono">{q.lat == null ? get('lat') : fmt(q.lat, 6)}</td><td className="p-2 font-mono">{q.lon == null ? get('lon') : fmt(q.lon, 6)}</td>
                  <td className="p-2">{q.eligibleForSpatialValidation ? <span className="text-emerald-700 flex items-center gap-1"><CheckCircle2 className="w-3 h-3"/> eligible</span> : <span className="text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3 h-3"/> {q.qualityFlags.join(', ') || 'QC flag'}</span>}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </section>

        <div className="rounded-lg border border-[var(--line)] p-3 text-xs text-[var(--text-lo)] flex items-start gap-2">
          <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
          <p>Geospatial alignment converts GPS WGS84 coordinates to the scene-local ENU frame and provides EPSG:32634 reference coordinates. Radio identity analysis profiles NR PCI/ARFCN and LTE-anchor contexts, then compares measurement locations with active TX candidates. This does not automatically identify the serving gNB or make modem RSRP directly comparable with Sionna RT total received power. The original GPS track and vertical datum have not been independently verified. Datasets remain in backend process memory and are cleared when the backend restarts.</p>
        </div>
      </>}

      {!dataset && !busy && datasets.length === 0 && <div className="rounded-xl border border-dashed border-[var(--line)] p-8 text-center flex flex-col items-center gap-3">
        <Upload className="w-8 h-8 text-[var(--text-lo)]" />
        <div className="font-semibold">Import a Quectel CSV or GPS-joined CSV</div>
        <p className="text-sm text-[var(--text-lo)] max-w-xl">Recommended starting file: `measurements_with_gps.csv`, which contains both radio measurements and GPS coordinates. You can also import the original CSV without GPS to inspect its raw contents and compare the two sources.</p>
        <button className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-2" type="button" disabled={!backendOnline} onClick={() => fileRef.current?.click()}><Upload className="w-4 h-4"/> Choose CSV</button>
      </div>}
    </div>
  );
}
