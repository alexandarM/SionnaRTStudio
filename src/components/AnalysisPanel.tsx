// Modified in the alexandarM/SionnaRTStudio fork of puloktarafder/SionnaRTStudio.
// Upstream: https://github.com/puloktarafder/SionnaRTStudio

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Transmitter, Receiver, PropagationPath, ChannelMetrics, RadioMapGrid, InteractionKind, BuildingFootprint, SolverOptions, MaterialConfig } from '../types';
import { calculatePathLoss } from '../utils';
import { Zap, Activity, Waves, Scaling, AlertCircle, Info, Compass, Gauge, Radio, Square } from 'lucide-react';
import { NumberField } from './NumberField';
import { safeCreateExperiment, safeUpdateExperiment, sha256Json, summarizeUnknownExperimentResult } from '../lib/experimentLogging';
import {
  solveLinkKpi, LinkKpiResponse,
  checkPhyAvailable, startPhyBerSweep, getPhyBerStatus, cancelPhyBerJob, PhyBerResult,
} from '../api';

interface AnalysisPanelProps {
  tx: Transmitter;
  rx: Receiver;
  paths: PropagationPath[];
  metrics: ChannelMetrics;
  freqGhz: number;
  radioMap?: RadioMapGrid | null;
  // Needed by the on-demand link-level KPI solve (backend /api/linkkpi).
  buildings: BuildingFootprint[];
  maxDepth: number;
  solverOptions: SolverOptions;
  materials: MaterialConfig[];
  backendOnline: boolean;
}

const FR1_PRB_TABLE: Record<number, Record<number, number>> = {
  15: { 5: 25, 10: 52, 15: 79, 20: 106, 25: 133, 30: 160, 35: 188, 40: 216, 45: 242, 50: 270 },
  30: { 5: 11, 10: 24, 15: 38, 20: 51, 25: 65, 30: 78, 35: 92, 40: 106, 45: 119, 50: 133, 60: 162, 70: 189, 80: 217, 90: 245, 100: 273 },
  60: { 10: 11, 15: 18, 20: 24, 25: 31, 30: 38, 35: 44, 40: 51, 45: 58, 50: 65, 60: 79, 70: 93, 80: 107, 90: 121, 100: 135 },
};

const INTERACTION_COLORS: Record<InteractionKind, string> = {
  specular: '#4a727e',
  diffuse: '#5f7f5a',
  refraction: '#8f7ea8',
  diffraction: '#cc785c',
  other: '#a8a49a',
};

export function AnalysisPanel({ tx, rx, paths, metrics, freqGhz, radioMap, buildings, maxDepth, solverOptions, materials, backendOnline }: AnalysisPanelProps) {
  // ── Link-level Shannon KPIs (ray-traced CFR → capacity, on demand) ────────
  const [kpi, setKpi] = useState<LinkKpiResponse | null>(null);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [kpiError, setKpiError] = useState('');
  const [kpiNumSc, setKpiNumSc] = useState(1024);
  const [kpiSpacingKhz, setKpiSpacingKhz] = useState(30);
  const [kpiNoiseFigureDb, setKpiNoiseFigureDb] = useState(7);
  const [kpiSnrOverride, setKpiSnrOverride] = useState(''); // '' = link-budget SNR

  // ── PHY BER/BLER sweep (5G NR PUSCH, optional backend package) ───────────
  const [phyAvailable, setPhyAvailable] = useState(false);
  const [phyResult, setPhyResult] = useState<PhyBerResult | null>(null);
  const [phyJobId, setPhyJobId] = useState<string | null>(null);
  const [phyExperimentId, setPhyExperimentId] = useState<string | null>(null);
  const phyExperimentStartedAt = useRef<number>(0);
  const [phyProgress, setPhyProgress] = useState(0);
  const [phyMessage, setPhyMessage] = useState('');
  const [phyError, setPhyError] = useState('');
  const [phyMcs, setPhyMcs] = useState(14);
  const [phyMcsTable, setPhyMcsTable] = useState<1 | 2 | 3>(1);
  const [phyBandwidthMHz, setPhyBandwidthMHz] = useState(20);
  const [phyScsKhz, setPhyScsKhz] = useState(30);
  const [phyCellId, setPhyCellId] = useState(1);
  const [phyCyclicPrefix, setPhyCyclicPrefix] = useState<'normal' | 'extended'>('normal');
  const [phyDmrsType, setPhyDmrsType] = useState<1 | 2>(1);
  const [phyDmrsAdditional, setPhyDmrsAdditional] = useState<0 | 1 | 2 | 3>(0);
  const [phyChannelMode, setPhyChannelMode] = useState<'normalized' | 'absolute'>('normalized');
  const [phyUeTxPowerDbm, setPhyUeTxPowerDbm] = useState(23);
  const [phyReceiverNoiseFigureDb, setPhyReceiverNoiseFigureDb] = useState(7);
  const phyPrb = FR1_PRB_TABLE[phyScsKhz]?.[phyBandwidthMHz] ?? 0;
  const phyBandwidthOptions = Object.keys(FR1_PRB_TABLE[phyScsKhz] || {}).map(Number);
  const [phySnrMin, setPhySnrMin] = useState(-10);
  const [phySnrMax, setPhySnrMax] = useState(14);
  const [phySnrStep, setPhySnrStep] = useState(1);
  const [phySlots, setPhySlots] = useState(32);

  // Results are only valid for the link configuration they were requested
  // under; async completions tagged with an older epoch must be discarded.
  const configEpoch = useRef(0);
  const phyJobEpoch = useRef(0);

  useEffect(() => {
    if (backendOnline) checkPhyAvailable().then(setPhyAvailable);
  }, [backendOnline]);

  // Poll the background job with one request in flight at a time. A sweep can
  // take minutes; status reads should be short, but transient proxy/CPU delays
  // must not mark the still-running backend job as failed. Retry with bounded
  // backoff and keep the job ID so the user cannot accidentally start a second
  // job while the first one is still executing.
  useEffect(() => {
    if (!phyJobId) return;

    let cancelled = false;
    let timer: number | undefined;
    let consecutiveFailures = 0;

    const scheduleNext = (delayMs: number) => {
      if (!cancelled) timer = window.setTimeout(poll, delayMs);
    };

    const poll = async () => {
      if (cancelled) return;
      const live = phyJobEpoch.current === configEpoch.current;
      try {
        const st = await getPhyBerStatus(phyJobId);
        if (cancelled) return;
        consecutiveFailures = 0;
        setPhyProgress(st.progress);
        setPhyMessage(live ? st.message : 'Finishing superseded sweep…');
        if (st.status === 'done') {
          if (live) setPhyResult(st.result ?? null);
          if (st.result) void safeUpdateExperiment(phyExperimentId, {
            status: 'done', completedAtUtc: new Date().toISOString(),
            durationMs: phyExperimentStartedAt.current ? performance.now() - phyExperimentStartedAt.current : undefined,
            results: summarizeUnknownExperimentResult('phy_sweep', st.result), error: null,
          });
          setPhyJobId(null);
          setPhyExperimentId(null);
          return;
        }
        if (st.status === 'error') {
          if (live) setPhyError(st.message);
          void safeUpdateExperiment(phyExperimentId, { status: 'error', completedAtUtc: new Date().toISOString(), durationMs: phyExperimentStartedAt.current ? performance.now() - phyExperimentStartedAt.current : undefined, error: st.message });
          setPhyJobId(null);
          setPhyExperimentId(null);
          return;
        }
        if (st.status === 'cancelled') {
          if (live) setPhyMessage(st.message || 'Sweep cancelled');
          void safeUpdateExperiment(phyExperimentId, { status: 'cancelled', completedAtUtc: new Date().toISOString(), durationMs: phyExperimentStartedAt.current ? performance.now() - phyExperimentStartedAt.current : undefined, error: st.message });
          setPhyJobId(null);
          setPhyExperimentId(null);
          return;
        }
        scheduleNext(2000);
      } catch (e: any) {
        if (cancelled) return;
        const message = e?.message || 'PHY status poll failed';
        // A 404 means the backend process/job registry was reset; retrying
        // cannot recover that job. Other failures may be transient.
        if (/unknown phy job|404/i.test(String(message))) {
          if (live) setPhyError(`${message}. The backend no longer has this job; check its log before starting another sweep.`);
          void safeUpdateExperiment(phyExperimentId, { status: 'error', completedAtUtc: new Date().toISOString(), error: `${message}. Backend job registry unavailable.` });
          setPhyJobId(null);
          setPhyExperimentId(null);
          return;
        }
        consecutiveFailures += 1;
        const retryMs = Math.min(15_000, 2000 * (2 ** Math.min(consecutiveFailures - 1, 3)));
        if (live) {
          setPhyMessage(`Status check delayed (${message}); retrying in ${Math.round(retryMs / 1000)}s…`);
        }
        scheduleNext(retryMs);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [phyJobId, phyExperimentId]);

  const runPhySweep = async () => {
    phyJobEpoch.current = configEpoch.current;
    const startedAtUtc = new Date().toISOString();
    const started = performance.now();
    phyExperimentStartedAt.current = started;
    setPhyExperimentId(null);
    setPhyError('');
    setPhyResult(null);
    setPhyProgress(0);
    setPhyMessage('Starting…');
    const phyOptions = {
      mcsIndex: phyMcs, mcsTable: phyMcsTable, channelBandwidthMHz: phyBandwidthMHz,
      subcarrierSpacing: phyScsKhz * 1000, nCellId: phyCellId, cyclicPrefix: phyCyclicPrefix,
      dmrsConfigType: phyDmrsType, dmrsAdditionalPosition: phyDmrsAdditional,
      channelMode: phyChannelMode, ueTxPowerDbm: phyUeTxPowerDbm,
      receiverNoiseFigureDb: phyReceiverNoiseFigureDb,
      snrMinDb: phySnrMin, snrMaxDb: phySnrMax, snrStepDb: phySnrStep,
      slotsPerPoint: phySlots,
    };
    const replayBody = { tx, rx, buildings, freqGhz, maxDepth, options: solverOptions, materials, ...phyOptions, seed: 42 };
    const configuration = { tx, rx, freqGhz, maxDepth, solverOptions, materials, phyOptions, scene: { buildingCount: buildings.length, geometryFingerprint: await sha256Json(buildings) } };
    try {
      const job = await startPhyBerSweep(tx, rx, buildings, freqGhz, maxDepth, solverOptions, materials, phyOptions);
      const log = await safeCreateExperiment({
        name: `NR PUSCH BER/BLER sweep · MCS ${phyMcs} · ${phyChannelMode}`, kind: 'phy_sweep', status: 'running',
        startedAtUtc, seed: 42, configuration,
        parameters: { ...phyOptions, maxDepth, pathSeed: solverOptions.pathSeed, pathSamplesPerSource: solverOptions.pathSamplesPerSource },
        results: { jobId: job.jobId, status: 'running' },
        replay: { endpoint: '/api/phyber', body: replayBody, description: 'Repeat NR PUSCH BER/BLER sweep' },
      });
      setPhyExperimentId(log?.id ?? null);
      setPhyJobId(job.jobId);
      setPhyMessage(job.message || 'Queued');
    } catch (e: any) {
      const errorText = e?.message || 'PHY sweep failed to start';
      setPhyError(errorText);
      await safeCreateExperiment({
        name: `NR PUSCH BER/BLER sweep · MCS ${phyMcs} · ${phyChannelMode}`, kind: 'phy_sweep', status: 'error',
        startedAtUtc, completedAtUtc: new Date().toISOString(), durationMs: performance.now() - started,
        seed: 42, configuration,
        parameters: phyOptions, results: {}, error: errorText,
        replay: { endpoint: '/api/phyber', body: replayBody, description: 'Retry NR PUSCH BER/BLER sweep' },
      });
    }
  };

  const cancelPhySweep = async () => {
    if (!phyJobId) return;
    try {
      const status = await cancelPhyBerJob(phyJobId);
      setPhyMessage(status.message || 'Cancellation requested');
    } catch (error: any) {
      setPhyError(error?.message || 'Could not cancel the PHY sweep');
    }
  };

  // KPI results describe one exact link configuration — drop them when it changes.
  useEffect(() => {
    configEpoch.current += 1;
    setKpi(null);
    setKpiError('');
    setPhyResult(null);
    setPhyError('');
  }, [tx, rx, buildings, freqGhz, maxDepth, solverOptions, materials]);

  const runLinkKpi = async () => {
    const epoch = configEpoch.current;
    const startedAtUtc = new Date().toISOString();
    const started = performance.now();
    const override = kpiSnrOverride.trim() === '' ? null : Number(kpiSnrOverride);
    const kpiOptions = { numSubcarriers: kpiNumSc, subcarrierSpacing: kpiSpacingKhz * 1000, noiseFigureDb: kpiNoiseFigureDb, snrOverrideDb: override != null && Number.isFinite(override) ? override : null };
    const replayBody = { tx, rx, buildings, freqGhz, maxDepth, options: solverOptions, materials, ...kpiOptions };
    const configuration = { tx, rx, freqGhz, maxDepth, solverOptions, materials, kpiOptions, scene: { buildingCount: buildings.length, geometryFingerprint: await sha256Json(buildings) } };
    let status: 'done' | 'error' = 'done';
    let resultSummary: Record<string, unknown> = {};
    let errorText: string | null = null;
    setKpiLoading(true);
    setKpiError('');
    try {
      const res = await solveLinkKpi(tx, rx, buildings, freqGhz, maxDepth, solverOptions, materials, kpiOptions);
      if (epoch === configEpoch.current) setKpi(res);
      resultSummary = summarizeUnknownExperimentResult('link_kpi', res);
    } catch (e: any) {
      status = 'error'; errorText = e?.message || 'Link KPI solve failed';
      if (epoch === configEpoch.current) setKpiError(errorText);
    } finally {
      setKpiLoading(false);
      await safeCreateExperiment({
        name: `Link KPI · ${tx.name} → ${rx.name}`, kind: 'link_kpi', status,
        startedAtUtc, completedAtUtc: new Date().toISOString(), durationMs: performance.now() - started,
        seed: solverOptions.pathSeed, configuration,
        parameters: { ...kpiOptions, pathSeed: solverOptions.pathSeed, pathSamplesPerSource: solverOptions.pathSamplesPerSource },
        results: resultSummary, error: errorText,
        replay: { endpoint: '/api/linkkpi', body: replayBody, description: 'Repeat link-level Shannon KPI analysis' },
      });
    }
  };

  // Calculations for Link Budget Equation
  const txPortCount = useMemo(() => {
    const polarizationPorts = solverOptions.txPolarization === 'VH' || solverOptions.txPolarization === 'cross' ? 2 : 1;
    return tx.antennaArraySize[0] * tx.antennaArraySize[1] * polarizationPorts;
  }, [tx.antennaArraySize, solverOptions.txPolarization]);

  const rxPortCount = useMemo(() => {
    const polarizationPorts = solverOptions.rxPolarization === 'VH' || solverOptions.rxPolarization === 'cross' ? 2 : 1;
    return rx.antennaArraySize[0] * rx.antennaArraySize[1] * polarizationPorts;
  }, [rx.antennaArraySize, solverOptions.rxPolarization]);

  const antennaGainTx = useMemo(() => {
    return (10 * Math.log10(txPortCount)).toFixed(1);
  }, [txPortCount]);

  const antennaGainRx = useMemo(() => {
    return (10 * Math.log10(rxPortCount)).toFixed(1);
  }, [rxPortCount]);

  const spatialMode = useMemo(() => {
    if (txPortCount > 1 && rxPortCount > 1) return 'MIMO channel matrix';
    if (txPortCount > 1) return 'MISO (Tx array)';
    if (rxPortCount > 1) return 'SIMO (Rx array)';
    return 'SISO';
  }, [txPortCount, rxPortCount]);

  const directDistance = useMemo(() => {
    return Math.sqrt(
      Math.pow(rx.enu.x - tx.enu.x, 2) + Math.pow(rx.enu.y - tx.enu.y, 2) + Math.pow(rx.height - tx.height, 2)
    );
  }, [tx, rx]);

  const rawFspl = useMemo(() => {
    return calculatePathLoss(directDistance, freqGhz).toFixed(1);
  }, [directDistance, freqGhz]);

  // Angular spectrum (AoA azimuth, power-weighted) + exact interaction-type mix,
  // straight from the Sionna paths (interactionKinds / theta_r,phi_r).
  const angular = useMemo(() => {
    const kinds: Record<InteractionKind, number> = {
      specular: 0, diffuse: 0, refraction: 0, diffraction: 0, other: 0,
    };
    for (const p of paths) {
      for (const k of p.interactionKinds ?? []) kinds[k] = (kinds[k] ?? 0) + 1;
    }
    const NB = 12; // 30°-wide azimuth sectors
    const bins = new Array<number>(NB).fill(0);
    let withAngles = 0;
    for (const p of paths) {
      if (p.aoaAzimuthDeg == null) continue;
      withAngles += 1;
      const az = ((p.aoaAzimuthDeg % 360) + 360) % 360;
      const idx = Math.min(NB - 1, Math.floor(az / (360 / NB)));
      bins[idx] += Math.pow(10, p.receivedPowerDbm / 10);
    }
    const maxBin = Math.max(...bins, 1e-30);
    const totalKinds = Object.values(kinds).reduce((a, b) => a + b, 0);
    return { kinds, bins, maxBin, withAngles, totalKinds };
  }, [paths]);

  const coverageStats = radioMap?.stats ?? null;

  // Generate SVG points for dynamic path loss curves (10m to 500m)
  const renderPathLossChart = () => {
    const frequencies = [2.4, 5.8, 28.0, 140.0];
    const distances = Array.from({ length: 30 }).map((_, i) => 10 + i * 17); // 10m to 500m

    const minLoss = 50; // dBs
    const maxLoss = 150; // dBs
    
    const chartW = 380;
    const chartH = 130;

    const mapX = (d: number) => 40 + ((d - 10) / (500 - 10)) * (chartW - 60);
    const mapY = (db: number) => chartH - 20 - ((db - minLoss) / (maxLoss - minLoss)) * (chartH - 35);

    const freqColors: { [f: number]: string } = {
      2.4: '#5f7f5a', // green
      5.8: '#4a727e', // blue
      28.0: '#cc785c', // orange
      140.0: '#b4483c', // red
    };

    return (
      <div className="bg-[#f5f3ec] border border-[#e3e0d6] rounded p-4 flex flex-col gap-2.5">
        <h4 className="eyebrow flex items-center gap-1.5">
          <Scaling className="w-3.5 h-3.5 text-[#cc785c]" /> Free Space Path Loss (FSPL) Curves (10m - 500m)
        </h4>

        <svg className="w-full h-[140px]" viewBox="0 0 400 140">
          {/* Grid lines */}
          <line x1="40" y1="110" x2="380" y2="110" stroke="#e3e0d6" strokeWidth="1" />
          <line x1="40" y1="10" x2="40" y2="110" stroke="#e3e0d6" strokeWidth="1" />
          
          <line x1="40" y1="60" x2="380" y2="60" stroke="#ebe7dc" strokeWidth="1" strokeDasharray="3" />
          <line x1="210" y1="10" x2="210" y2="110" stroke="#ebe7dc" strokeWidth="1" strokeDasharray="3" />

          {/* Coordinate Labels */}
          <text x="35" y="15" textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">150 dB</text>
          <text x="35" y="62" textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">100 dB</text>
          <text x="35" y="110" textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">50 dB</text>

          <text x="40" y="122" fontSize="7" fill="#6b6862" fontFamily="monospace">10m</text>
          <text x="210" y="122" textAnchor="middle" fontSize="7" fill="#6b6862" fontFamily="monospace">250m</text>
          <text x="380" y="122" textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">500m (Distance)</text>

          {/* Generate lines for each frequency */}
          {frequencies.map((f) => {
            const pathData = distances
              .map((d) => {
                const loss = calculatePathLoss(d, f);
                // Clamp loss to graph constraints
                const clampedLoss = Math.max(minLoss, Math.min(maxLoss, loss));
                return `${mapX(d)},${mapY(clampedLoss)}`;
              })
              .join(' ');

            return (
              <g key={f}>
                <polyline
                  fill="none"
                  stroke={freqColors[f]}
                  strokeWidth={freqGhz === f ? '2.5' : '1.2'}
                  strokeOpacity={freqGhz === f ? '1.0' : '0.4'}
                  points={pathData}
                  className="transition-all duration-150"
                />
                {/* Hover Legend markers */}
                {freqGhz === f && (
                  <circle
                    cx={mapX(Math.max(10, Math.min(500, directDistance)))}
                    cy={mapY(Math.max(minLoss, Math.min(maxLoss, parseFloat(rawFspl))))}
                    r="4.5"
                    fill={freqColors[f]}
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />
                )}
              </g>
            );
          })}
        </svg>

        {/* Legend color indicators */}
        <div className="flex flex-wrap gap-4 items-center justify-center text-[11px] font-mono mt-1">
          {frequencies.map((f) => (
            <div key={f} className={`flex items-center gap-1.5 px-2 py-0.5 rounded ${freqGhz === f ? 'bg-[#ebe7dc] border border-[#e3e0d6]' : ''}`}>
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: freqColors[f] }} />
              <span className={freqGhz === f ? 'font-bold text-slate-900' : 'text-slate-600'}>
                {f < 10 ? `${f} GHz` : f === 28 ? '28 GHz mmW' : '140 GHz sub-THz'}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Mean capacity vs receive SNR — open-loop (blue) and single-stream MRT
  // bound (orange), with the operating SNR marked on the open-loop curve.
  const renderCapacityCurve = (k: LinkKpiResponse) => {
    const xs = k.curve.snrDb;
    if (xs.length < 2) return null;
    const minX = xs[0];
    const maxX = xs[xs.length - 1];
    const maxY = Math.max(...k.curve.beamformed, 1);
    const chartW = 400;
    const chartH = 150;
    const mapX = (v: number) => 42 + ((v - minX) / (maxX - minX)) * (chartW - 104);
    const mapY = (v: number) => chartH - 26 - (v / maxY) * (chartH - 42);
    const line = (ys: number[]) => xs.map((s, i) => `${mapX(s)},${mapY(ys[i])}`).join(' ');
    const op = k.effectiveSnrDb;
    const opClamped = op == null ? null : Math.max(minX, Math.min(maxX, op));
    const opCapacity = op == null ? null : k.capacityOpenLoopBitsHz;
    return (
      <svg className="w-full h-[160px]" viewBox={`0 0 ${chartW} ${chartH}`}>
        <line x1="42" y1={chartH - 26} x2={chartW - 62} y2={chartH - 26} stroke="#e3e0d6" strokeWidth="1" />
        <line x1="42" y1="16" x2="42" y2={chartH - 26} stroke="#e3e0d6" strokeWidth="1" />
        <text x="37" y="20" textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">{maxY.toFixed(0)}</text>
        <text x="37" y={chartH - 24} textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">0</text>
        <text x="20" y={chartH / 2} textAnchor="middle" fontSize="7" fill="#6b6862" fontFamily="monospace" transform={`rotate(-90 14 ${chartH / 2})`}>bit/s/Hz</text>
        <text x="42" y={chartH - 14} fontSize="7" fill="#6b6862" fontFamily="monospace">{minX.toFixed(0)} dB</text>
        <text x={chartW - 62} y={chartH - 14} textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">{maxX.toFixed(0)} dB (receive SNR)</text>
        {opClamped != null && (
          <g>
            <line x1={mapX(opClamped)} y1="16" x2={mapX(opClamped)} y2={chartH - 26} stroke="#a8a49a" strokeWidth="1" strokeDasharray="3" />
            {opCapacity != null && (
              <circle cx={mapX(opClamped)} cy={mapY(Math.min(opCapacity, maxY))} r="4" fill="#4a727e" stroke="#ffffff" strokeWidth="1.5" />
            )}
            <text x={mapX(opClamped)} y="12" textAnchor="middle" fontSize="7" fill="#6b6862" fontFamily="monospace">op. SNR</text>
          </g>
        )}
        <polyline fill="none" stroke="#4a727e" strokeWidth="2" points={line(k.curve.openLoop)} />
        <polyline fill="none" stroke="#cc785c" strokeWidth="2.5" points={line(k.curve.beamformed)} />
        <text x={chartW - 58} y={mapY(k.curve.openLoop[xs.length - 1])} fontSize="8" fontWeight="bold" fill="#4a727e" fontFamily="monospace">Open-loop</text>
        <text x={chartW - 58} y={mapY(k.curve.beamformed[xs.length - 1])} fontSize="8" fontWeight="bold" fill="#cc785c" fontFamily="monospace">MRT bound</text>
      </svg>
    );
  };

  // Beamformed channel gain per subcarrier — the frequency selectivity the
  // capacity averages over.
  const renderKpiSpectrum = (k: LinkKpiResponse) => {
    const f = k.spectrum.frequencyHz;
    const g = k.spectrum.gainDb;
    if (f.length < 2) return null;
    const minY = Math.min(...g);
    const maxY = Math.max(...g);
    const pad = Math.max((maxY - minY) * 0.1, 1);
    const y0 = minY - pad;
    const y1 = maxY + pad;
    const chartW = 400;
    const chartH = 120;
    const mapX = (i: number) => 46 + (i / (f.length - 1)) * (chartW - 66);
    const mapY = (v: number) => chartH - 22 - ((v - y0) / (y1 - y0)) * (chartH - 36);
    return (
      <svg className="w-full h-[130px]" viewBox={`0 0 ${chartW} ${chartH}`}>
        <line x1="46" y1={chartH - 22} x2={chartW - 20} y2={chartH - 22} stroke="#e3e0d6" strokeWidth="1" />
        <line x1="46" y1="12" x2="46" y2={chartH - 22} stroke="#e3e0d6" strokeWidth="1" />
        <text x="41" y="16" textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">{y1.toFixed(0)} dB</text>
        <text x="41" y={chartH - 20} textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">{y0.toFixed(0)} dB</text>
        <text x="46" y={chartH - 10} fontSize="7" fill="#6b6862" fontFamily="monospace">{(f[0] / 1e6).toFixed(1)} MHz</text>
        <text x={chartW - 20} y={chartH - 10} textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">{(f[f.length - 1] / 1e6).toFixed(1)} MHz (offset)</text>
        <polyline fill="none" stroke="#5f7f5a" strokeWidth="2" points={g.map((v, i) => `${mapX(i)},${mapY(v)}`).join(' ')} />
      </svg>
    );
  };

  // BER (blue) and BLER (orange) vs Eb/N0 on a log-10 y axis. Zero rates are
  // clamped to the 1e-6 floor (rendered as open markers: "below measurement").
  const renderBerChart = (r: PhyBerResult) => {
    const pts = r.points;
    if (pts.length < 2) return null;
    const FLOOR = 1e-6;
    const minX = pts[0].ebNoDb;
    const maxX = pts[pts.length - 1].ebNoDb;
    const chartW = 400;
    const chartH = 170;
    const mapX = (v: number) => 46 + ((v - minX) / (maxX - minX)) * (chartW - 106);
    const mapY = (v: number) => 14 + (-Math.log10(Math.max(v, FLOOR)) / 6) * (chartH - 40);
    const line = (get: (p: typeof pts[0]) => number) =>
      pts.map((p) => `${mapX(p.ebNoDb)},${mapY(get(p))}`).join(' ');
    return (
      <svg className="w-full h-[180px]" viewBox={`0 0 ${chartW} ${chartH}`}>
        {[0, 2, 4, 6].map((d) => (
          <g key={d}>
            <line x1="46" y1={14 + (d / 6) * (chartH - 40)} x2={chartW - 60} y2={14 + (d / 6) * (chartH - 40)} stroke="#e3e0d6" strokeWidth="1" strokeDasharray={d === 0 ? undefined : '3'} />
            <text x="41" y={17 + (d / 6) * (chartH - 40)} textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">
              {d === 0 ? '1' : `1e-${d}`}
            </text>
          </g>
        ))}
        <line x1="46" y1="14" x2="46" y2={chartH - 26} stroke="#e3e0d6" strokeWidth="1" />
        <text x="46" y={chartH - 14} fontSize="7" fill="#6b6862" fontFamily="monospace">{minX.toFixed(1)} dB</text>
        <text x={chartW - 60} y={chartH - 14} textAnchor="end" fontSize="7" fill="#6b6862" fontFamily="monospace">{maxX.toFixed(1)} dB ({r.channelMode === 'absolute' ? 'effective Eb/N0' : 'Eb/N0'})</text>
        <polyline fill="none" stroke="#4a727e" strokeWidth="2" points={line((p) => p.ber)} />
        <polyline fill="none" stroke="#cc785c" strokeWidth="2.5" points={line((p) => p.bler)} />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={mapX(p.ebNoDb)} cy={mapY(p.ber)} r="2.5" fill={p.ber <= FLOOR ? '#ffffff' : '#4a727e'} stroke="#4a727e" strokeWidth="1.2" />
            <circle cx={mapX(p.ebNoDb)} cy={mapY(p.bler)} r="2.5" fill={p.bler <= FLOOR ? '#ffffff' : '#cc785c'} stroke="#cc785c" strokeWidth="1.2" />
          </g>
        ))}
        <text x={chartW - 56} y={mapY(pts[pts.length - 1].ber) + 3} fontSize="8" fontWeight="bold" fill="#4a727e" fontFamily="monospace">BER</text>
        <text x={chartW - 56} y={mapY(pts[pts.length - 1].bler) - 4} fontSize="8" fontWeight="bold" fill="#cc785c" fontFamily="monospace">BLER</text>
      </svg>
    );
  };

  return (
    <div id="propagation-analysis-panel" className="panel p-5 flex flex-col gap-6 h-full overflow-y-auto">
      {/* Title block */}
      <div className="flex items-center gap-2 border-b border-[#e3e0d6] pb-3">
        <Zap className="w-5 h-5 text-[#cc785c]" />
        <div>
          <h3 className="panel-title">Channel Propagation Solver Analytics</h3>
          <p className="text-[12px] text-[#6b6862] font-semibold">Link Budgets, Attenuations & Wave Phasing</p>
        </div>
      </div>

      {/* RF Link Budget Formula Cards */}
      <div className="flex flex-col gap-3">
        <h4 className="eyebrow flex items-center gap-1">
          <Info className="w-3.5 h-3.5 text-slate-600" /> Physical Link Budget Equation (Massive MIMO Enabled)
        </h4>

        {/* Mathematical Equation display box */}
        <div className="bg-[#f5f3ec] p-3.5 rounded border border-[#e3e0d6] font-mono text-[14px] flex flex-col gap-2 shadow-inner leading-relaxed">
          <div className="text-center py-1 text-slate-600 border-b border-[#ebe7dc] text-[14px]">
            <span className="text-[#5f7f5a] font-bold">P_rx</span> = 
            <span className="text-slate-900"> P_tx</span> + 
            <span className="text-[#4a727e]"> G_tx</span> + 
            <span className="text-[#4a727e]"> G_rx</span> - 
            <span className="text-red-400"> FSPL</span> - 
            <span className="text-orange-400"> L_bounce</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] text-slate-600 mt-1">
            <div>
              <strong className="text-[#5f7f5a]">P_rx</strong>: Rec. power ({metrics.totalRxPowerDbm.toFixed(1)} dBm)
            </div>
            <div>
              <strong className="text-slate-900">P_tx</strong>: Transmitter power ({tx.powerDbm} dBm)
            </div>
            <div>
              <strong className="text-[#4a727e]">G_tx</strong>: Ideal coherent reference (+{antennaGainTx} dB, {txPortCount} ports)
            </div>
            <div>
              <strong className="text-[#4a727e]">G_rx</strong>: Ideal MRC reference (+{antennaGainRx} dB, {rxPortCount} ports)
            </div>
            <div>
              <strong className="text-red-400">FSPL</strong>: Direct Path Loss ({rawFspl} dB)
            </div>
            <div>
              <strong className="text-orange-400">L_bounce</strong>: Reflection interactions attenuation
            </div>
          </div>
        </div>
      </div>

      {/* Attenuation Graph & Dynamic Scatter */}
      {renderPathLossChart()}

      {/* Signal Attenuation Details Card */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Multipath Delay Profiles */}
        <div className="bg-[#f5f3ec] border border-[#e3e0d6] p-4 rounded flex flex-col gap-2.5">
          <h4 className="eyebrow flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-emerald-400" /> Channel Delay KPIs
          </h4>

          <div className="flex flex-col gap-2 text-[14px]">
            <div className="flex justify-between items-baseline gap-4 border-b border-[#ebe7dc] py-1.5">
              <span className="text-slate-600">Link LOS Status:</span>
              <span className={`font-bold font-mono uppercase ${metrics.losStatus === 'LOS' ? 'text-[#5f7f5a]' : 'text-[#cc785c]'}`}>
                {metrics.losStatus} Condition
              </span>
            </div>
            <div className="flex justify-between items-baseline gap-4 border-b border-[#ebe7dc] py-1.5">
              <span className="text-slate-600">RMS Delay Spread:</span>
              <span className="font-bold font-mono text-slate-900">
                {metrics.rmsDelaySpreadValid === false
                  ? 'N/A (inspect per-transmitter values)'
                  : `${metrics.rmsDelaySpreadNs.toFixed(2)} nanoseconds`}
              </span>
            </div>
            <div className="flex justify-between items-baseline gap-4 border-b border-[#ebe7dc] py-1.5">
              <span className="text-slate-600">Strongest Path Power:</span>
              <span className="font-bold font-mono text-emerald-400">{metrics.strongestPathPowerDbm.toFixed(1)} dBm</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-600">Resolved Path Bounces:</span>
              <span className="font-bold font-mono text-slate-900">{metrics.numPaths - 1} wall reflections</span>
            </div>
          </div>
        </div>

        {/* Phase & Frequency Specific KPIs */}
        <div className="bg-[#f5f3ec] border border-[#e3e0d6] p-4 rounded flex flex-col gap-2.5">
          <h4 className="eyebrow flex items-center gap-1.5">
            <Waves className="w-3.5 h-3.5 text-[#4a727e]" /> Phase Alignment & Attenuation
          </h4>

          <div className="flex flex-col gap-2 text-[14px]">
            <div className="flex justify-between items-baseline gap-4 border-b border-[#ebe7dc] py-1.5">
              <span className="text-slate-600">Carrier Wavelength:</span>
              <span className="font-bold font-mono text-slate-900">
                {((0.3 / (freqGhz + 1e-9)) * 100).toFixed(3)} centimeters
              </span>
            </div>
            <div className="flex justify-between items-baseline gap-4 border-b border-[#ebe7dc] py-1.5">
              <span className="text-slate-600">Atmospheric Absorption Index:</span>
              <span className="font-bold font-mono text-slate-600 text-right">
                {freqGhz > 60 ? 'High (60GHz Oxygen band)' : 'Standard Free Space attenuation'}
              </span>
            </div>
            <div className="flex justify-between items-baseline gap-4 border-b border-[#ebe7dc] py-1.5">
              <span className="text-slate-600">Multipath phase offset shift:</span>
              <span className="font-bold font-mono text-[#cc785c]">π (180° inversion on bounce)</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-600">Channel dimensions:</span>
              <span className="font-bold font-mono text-[#4a727e]">
                {spatialMode}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Angular spectrum + exact interaction-type mix (from Sionna paths) */}
      {angular.withAngles > 0 && (
        <div className="bg-[#f5f3ec] border border-[#e3e0d6] rounded p-4 flex flex-col gap-3">
          <h4 className="eyebrow flex items-center gap-1.5">
            <Compass className="w-3.5 h-3.5 text-[#cc785c]" /> Angular Spectrum & Interaction Mix
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* AoA azimuth power profile (12 sectors, clockwise from North) */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Power by Angle of Arrival (azimuth)</span>
              <svg className="w-full h-[120px]" viewBox="0 0 240 120">
                {angular.bins.map((v, i) => {
                  const bw = 240 / angular.bins.length;
                  const h = (v / angular.maxBin) * 92;
                  const az = i * (360 / angular.bins.length);
                  return (
                    <g key={i}>
                      <rect x={i * bw + 1} y={100 - h} width={bw - 2} height={Math.max(h, 0.5)} fill="#cc785c" opacity={0.55 + 0.45 * (v / angular.maxBin)} rx="1" />
                      {i % 3 === 0 && (
                        <text x={i * bw + bw / 2} y={113} textAnchor="middle" fontSize="7" fill="#6b6862" fontFamily="monospace">{az}°</text>
                      )}
                    </g>
                  );
                })}
                <line x1="0" y1="100" x2="240" y2="100" stroke="#e3e0d6" strokeWidth="1" />
              </svg>
              <span className="text-[11px] text-slate-500 font-mono">0°=N · 90°=E · 180°=S · 270°=W</span>
            </div>
            {/* Exact interaction-type breakdown */}
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Interaction Types ({angular.totalKinds} bounces)</span>
              {(Object.keys(angular.kinds) as InteractionKind[]).filter((k) => angular.kinds[k] > 0).map((k) => {
                const frac = angular.totalKinds ? angular.kinds[k] / angular.totalKinds : 0;
                return (
                  <div key={k} className="flex items-center gap-2">
                    <span className="w-16 text-[12px] font-semibold capitalize text-slate-700">{k}</span>
                    <div className="flex-1 h-2.5 rounded bg-white border border-[#e3e0d6] overflow-hidden">
                      <div className="h-full rounded" style={{ width: `${frac * 100}%`, backgroundColor: INTERACTION_COLORS[k] }} />
                    </div>
                    <span className="w-6 text-right font-mono text-[12px] font-bold text-slate-700">{angular.kinds[k]}</span>
                  </div>
                );
              })}
              {angular.totalKinds === 0 && (
                <span className="text-[12px] text-slate-500">LOS only — no interactions resolved.</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Link-level Shannon KPIs from the ray-traced CFR (backend /api/linkkpi) */}
      <div className="bg-[#f5f3ec] border border-[#e3e0d6] rounded p-4 flex flex-col gap-3">
        <h4 className="eyebrow flex items-center gap-1.5">
          <Gauge className="w-3.5 h-3.5 text-[#4a727e]" /> Link-Level KPIs · Shannon Upper Bound (Ray-Traced CFR)
        </h4>

        <div className="flex flex-wrap items-end gap-3 text-[12px]">
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            Subcarriers
            <select value={kpiNumSc} onChange={(e) => setKpiNumSc(Number(e.target.value))}
              className="bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800">
              {[256, 512, 1024, 2048].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            Spacing
            <select value={kpiSpacingKhz} onChange={(e) => setKpiSpacingKhz(Number(e.target.value))}
              className="bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800">
              {[15, 30, 60, 120].map((n) => <option key={n} value={n}>{n} kHz</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            Noise figure (dB)
            <NumberField
              value={kpiNoiseFigureDb}
              min={0}
              max={20}
              step={0.5}
              onChange={setKpiNoiseFigureDb}
              className="w-20 bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800"
            />
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            SNR override (dB)
            <input type="number" value={kpiSnrOverride} placeholder="link budget"
              onChange={(e) => setKpiSnrOverride(e.target.value)}
              className="w-24 bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800" />
          </label>
          <button onClick={runLinkKpi} disabled={kpiLoading || !backendOnline}
            className="btn-signal text-[14px] py-1.5 px-3.5 cursor-pointer border-none disabled:opacity-50">
            {kpiLoading ? 'Computing…' : 'Compute KPIs'}
          </button>
        </div>

        {kpiError && (
          <div className="text-[12px] text-red-500 font-mono">{kpiError}</div>
        )}
        {!kpi && !kpiError && (
          <p className="text-[12px] text-slate-500 leading-relaxed">
            Re-traces the active Tx→Rx link, samples <code>paths.cfr()</code> on the OFDM grid and reduces it to
            Idealized Shannon-capacity KPIs — open-loop vs beamformed capacity, spectral efficiency, spatial rank and
            coherence bandwidth. The rate is an upper-bound reference, not scheduled NR throughput. Noise floor:
            thermal over the grid bandwidth + noise figure.
          </p>
        )}

        {kpi && !kpi.reachable && (
          <div className="text-[12px] text-slate-600 font-mono bg-white border border-[#e3e0d6] rounded p-2.5">
            No ray-traced path reaches the receiver — capacity is zero. Move the devices or enable more interaction types.
          </div>
        )}

        {kpi && kpi.reachable && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-center">
              {([
                ['Open-loop capacity', kpi.capacityOpenLoopBitsHz.toFixed(2), 'bit/s/Hz'],
                ['Steered-beam capacity', kpi.capacityUniformBitsHz.toFixed(2), 'bit/s/Hz'],
                ['MRT bound', kpi.capacityBeamformedBitsHz.toFixed(2), 'bit/s/Hz'],
                ['Shannon rate upper bound', kpi.throughputMbps.toFixed(1), `Mbps · ${(kpi.bandwidthHz / 1e6).toFixed(1)} MHz`],
                [kpi.snrSource === 'override' ? 'Operating SNR (override)' : 'Effective SNR (link budget)',
                  kpi.effectiveSnrDb == null ? '—' : kpi.effectiveSnrDb.toFixed(1), 'dB'],
                ['Beamforming gain (MRT − steered)', kpi.beamformingGainDb == null ? '—' : kpi.beamformingGainDb.toFixed(2), 'dB'],
              ] as const).map(([lab, val, unit]) => (
                <div key={lab} className="flex flex-col gap-0.5 bg-white border border-[#e3e0d6] rounded py-2 px-1">
                  <span className="text-[11px] text-slate-500 font-bold">{lab}</span>
                  <span className="font-mono text-[14px] font-bold text-slate-800">{val}</span>
                  <span className="text-[11px] text-slate-400">{unit}</span>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-slate-600 border-t border-[#ebe7dc] pt-2">
              <span>Rx {kpi.rxPowerDbm == null ? '—' : kpi.rxPowerDbm.toFixed(1)} dBm</span>
              <span>Noise {kpi.noisePowerDbm.toFixed(1)} dBm</span>
              <span>{kpi.numRxAnt}×{kpi.numTxAnt} · {kpi.numSubcarriers} sc</span>
              <span>Eff. rank {kpi.effectiveRank == null ? '—' : kpi.effectiveRank.toFixed(2)}</span>
              <span>Cond. {kpi.conditionNumberDb == null ? '—' : `${kpi.conditionNumberDb.toFixed(1)} dB`}</span>
              <span>
                Coherence BW {kpi.coherenceBw50Hz == null
                  ? `≥ ${(kpi.bandwidthHz / 1e6).toFixed(1)} MHz (flat)`
                  : kpi.coherenceBw50Hz >= 1e6
                    ? `${(kpi.coherenceBw50Hz / 1e6).toFixed(2)} MHz`
                    : `${(kpi.coherenceBw50Hz / 1e3).toFixed(0)} kHz`}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Capacity vs Receive SNR</span>
                {renderCapacityCurve(kpi)}
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Channel Gain Across Subcarriers</span>
                {renderKpiSpectrum(kpi)}
              </div>
            </div>
          </>
        )}
      </div>

      {/* PHY BER/BLER — full 5G NR PUSCH chain over the ray-traced channel
          (backend background job; requires the optional Sionna PHY package). */}
      <div className="bg-[#f5f3ec] border border-[#e3e0d6] rounded p-4 flex flex-col gap-3">
        <h4 className="eyebrow flex items-center gap-1.5">
          <Radio className="w-3.5 h-3.5 text-[#cc785c]" /> PHY BER / BLER · 5G NR PUSCH over the Ray-Traced Channel
        </h4>

        <div className="flex flex-wrap items-end gap-3 text-[12px]">
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            MCS table
            <select value={phyMcsTable} onChange={(e) => {
              const next = Number(e.target.value) as 1 | 2 | 3;
              setPhyMcsTable(next);
              setPhyMcs((current) => Math.min(current, next === 2 ? 27 : 28));
            }} className="bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800">
              <option value={1}>Table 1 · 64QAM</option>
              <option value={2}>Table 2 · 256QAM</option>
              <option value={3}>Table 3 · 64QAM low-SE</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            MCS index
            <NumberField value={phyMcs} integer min={0} max={phyMcsTable === 2 ? 27 : 28}
              onChange={setPhyMcs}
              className="w-16 bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800" />
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            Channel BW (MHz)
            <select value={phyBandwidthMHz} onChange={(e) => setPhyBandwidthMHz(Number(e.target.value))}
              className="bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800">
              {phyBandwidthOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            SCS (kHz)
            <select value={phyScsKhz} onChange={(e) => {
              const next = Number(e.target.value);
              const allowed = Object.keys(FR1_PRB_TABLE[next] || {}).map(Number);
              setPhyScsKhz(next);
              if (!allowed.includes(phyBandwidthMHz)) {
                setPhyBandwidthMHz(allowed.includes(20) ? 20 : allowed[0]);
              }
              if (next !== 60) setPhyCyclicPrefix('normal');
            }} className="bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800">
              {[15, 30, 60].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            PCI
            <NumberField value={phyCellId} integer min={0} max={1007} onChange={setPhyCellId}
              className="w-16 bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800" />
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            Cyclic prefix
            <select value={phyCyclicPrefix} onChange={(e) => setPhyCyclicPrefix(e.target.value as 'normal' | 'extended')}
              className="bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800">
              <option value="normal">Normal</option>
              <option value="extended" disabled={phyScsKhz !== 60}>Extended (60 kHz)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            DMRS type
            <select value={phyDmrsType} onChange={(e) => setPhyDmrsType(Number(e.target.value) as 1 | 2)}
              className="bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800">
              <option value={1}>Type 1</option>
              <option value={2}>Type 2</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            DMRS additional position
            <select value={phyDmrsAdditional} onChange={(e) => setPhyDmrsAdditional(Number(e.target.value) as 0 | 1 | 2 | 3)}
              className="bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800">
              {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            Channel mode
            <select value={phyChannelMode} onChange={(e) => {
              const next = e.target.value as 'normalized' | 'absolute';
              setPhyChannelMode(next);
              if (next === 'absolute') {
                // Start near the expected transition while keeping 0 dB — the
                // physical link-budget operating point — inside the sweep.
                setPhySnrMin(-2);
                setPhySnrMax(2);
                setPhySnrStep(1);
              } else {
                setPhySnrMin(-10);
                setPhySnrMax(14);
                setPhySnrStep(1);
              }
              setPhyResult(null);
              setPhyError('');
            }} className="bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800">
              <option value="normalized">Normalized Eb/N0</option>
              <option value="absolute">Absolute link budget</option>
            </select>
          </label>
          {phyChannelMode === 'absolute' && (
            <>
              <label className="flex flex-col gap-1 text-slate-600 font-semibold">
                UE Tx power (dBm)
                <NumberField value={phyUeTxPowerDbm} min={-10} max={33} step={0.5} onChange={setPhyUeTxPowerDbm}
                  className="w-20 bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800" />
              </label>
              <label className="flex flex-col gap-1 text-slate-600 font-semibold">
                BS Rx noise figure (dB)
                <NumberField value={phyReceiverNoiseFigureDb} min={0} max={20} step={0.5} onChange={setPhyReceiverNoiseFigureDb}
                  className="w-20 bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800" />
              </label>
            </>
          )}
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            {phyChannelMode === 'absolute' ? 'Link offset from (dB)' : 'Eb/N0 from (dB)'}
            <NumberField value={phySnrMin} min={-40} max={60} step={0.5} onChange={setPhySnrMin}
              className="w-16 bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800" />
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            {phyChannelMode === 'absolute' ? 'Link offset to (dB)' : 'Eb/N0 to (dB)'}
            <NumberField value={phySnrMax} min={-40} max={60} step={0.5} onChange={setPhySnrMax}
              className="w-16 bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800" />
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            Step (dB)
            <select value={phySnrStep} onChange={(e) => setPhySnrStep(Number(e.target.value))}
              className="bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800">
              <option value={0.5}>0.5</option>
              <option value={1}>1.0</option>
              <option value={2}>2.0</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600 font-semibold">
            Slots/point
            <select value={phySlots} onChange={(e) => setPhySlots(Number(e.target.value))}
              className="bg-white border border-[#e3e0d6] rounded px-2 py-1 font-mono text-slate-800">
              {[16, 32, 64, 128, 256, 512].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <span className="text-[11px] text-slate-500 font-mono pb-1">
            {phyPrb ? `${phyPrb} PRB · ${phyPrb * 12} subcarriers · ${(phyPrb * 12 * phyScsKhz / 1000).toFixed(2)} MHz occupied` : 'Invalid FR1 grid'}
          </span>
          <button onClick={runPhySweep} disabled={!!phyJobId || !backendOnline || !phyAvailable || !phyPrb || phySnrMax < phySnrMin || (phySnrMax - phySnrMin) / phySnrStep > 40 || Math.abs(((phySnrMax - phySnrMin) / phySnrStep) - Math.round((phySnrMax - phySnrMin) / phySnrStep)) > 1e-7}
            className="btn-signal text-[14px] py-1.5 px-3.5 cursor-pointer border-none disabled:opacity-50">
            {phyJobId ? 'Sweeping…' : 'Run BER Sweep'}
          </button>
          {phyJobId && <button type="button" onClick={() => void cancelPhySweep()} className="inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-800 hover:bg-rose-100"><Square className="h-3 w-3"/> Cancel sweep</button>}
        </div>

        {phyChannelMode === 'absolute' ? (
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Absolute mode keeps the unnormalized Sionna RT channel. UE conducted Tx power is assumed to be uniformly spread across the active PUSCH bandwidth; thermal noise uses 293 K, the selected BS receiver noise figure, and occupied bandwidth. A 0 dB link offset is the physical link-budget operating point; negative offsets add noise and positive offsets reduce it. This reciprocal PUSCH model does not yet include NR uplink power control, inter-cell interference, HARQ, or a scheduler.
          </p>
        ) : (
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Normalized mode scales the ray-traced CFR to unit mean energy and sweeps the entered Eb/N0 values. It isolates multipath/frequency selectivity from absolute path loss. Choose a 0.5, 1, or 2 dB step to refine the waterfall curve.
          </p>
        )}

        {!phyAvailable && backendOnline && (
          <p className="text-[12px] text-slate-500">
            The optional Sionna PHY package is not installed on the backend —{' '}
            <code className="font-mono">pip install -r backend/requirements-phy.txt</code> and restart to enable BER sweeps.
          </p>
        )}
        {phyError && <div className="text-[12px] text-red-500 font-mono">{phyError}</div>}

        {phyJobId && (
          <div className="flex flex-col gap-1">
            <div className="h-2 rounded bg-white border border-[#e3e0d6] overflow-hidden">
              <div className="h-full bg-[#cc785c] rounded transition-all" style={{ width: `${Math.round(phyProgress * 100)}%` }} />
            </div>
            <span className="text-[11px] text-slate-500 font-mono">{phyMessage}</span>
          </div>
        )}

        {!phyResult && !phyJobId && !phyError && phyAvailable && (
          <p className="text-[12px] text-slate-500 leading-relaxed">
            {phyChannelMode === 'normalized'
              ? 'Simulates a standards-based subset of NR FR1 PUSCH (LDPC transport blocks, QAM, DMRS, default Sionna LS channel estimation and LMMSE detection) on the reciprocal uplink. The FR1 bandwidth/SCS pair determines PRBs using the 3GPP TS 38.104 table. The ray-traced channel is normalized to unit mean energy: Eb/N0 excludes absolute path loss and this sweep includes AWGN only, not inter-cell interference.'
              : 'Simulates reciprocal NR FR1 PUSCH with the unnormalized ray-traced channel. The physical reference point is derived from UE conducted power, mean RT channel gain, occupied bandwidth, 293 K thermal noise and BS receiver noise figure. The displayed baseline Eb/N0 is an approximate MCS-equivalent value; this mode does not yet include inter-cell interference, uplink power control, HARQ or a scheduler.'}
          </p>
        )}

        {phyResult && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-slate-600">
              <span>{phyResult.channelMode === 'absolute' ? 'ABSOLUTE LINK BUDGET' : 'NORMALIZED CHANNEL'}</span>
              <span>MCS table {phyResult.mcsTable} / index {phyResult.mcsIndex} · {phyResult.modulationOrder} bit/sym · r={phyResult.targetCoderate.toFixed(3)}</span>
              <span>{phyResult.channelBandwidthMHz ?? 'Custom'} MHz · {phyResult.subcarrierSpacingHz / 1000} kHz · {phyResult.numPrb} PRB ({phyResult.numSubcarriers} sc)</span>
              <span>PCI {phyResult.nCellId} · {phyResult.cyclicPrefix} CP · DMRS type {phyResult.dmrsConfigType} / +{phyResult.dmrsAdditionalPosition}</span>
              <span>
                {phyResult.numRxAnt} BS ports ← {phyResult.numTxAnt} UE stream
                {phyResult.numUeArrayPorts > 1 ? ` / ${phyResult.numUeArrayPorts} array ports` : ''}
              </span>
              <span>TB {phyResult.transportBlockBits} bits</span>
              <span>{phyResult.numPaths} paths</span>
              <span>{phyResult.slotsPerPoint} slots/pt</span>
            </div>
            {phyResult.channelMode === 'absolute' && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 rounded border border-[#d9e3df] bg-[#f0f5f2] p-3 text-[11px] font-mono">
                <div><div className="text-slate-500">UE conducted power</div><strong>{phyResult.ueTxPowerDbm?.toFixed(1)} dBm</strong></div>
                <div><div className="text-slate-500">Mean combined Rx signal power</div><strong>{phyResult.rxPowerDbm?.toFixed(1)} dBm</strong></div>
                <div><div className="text-slate-500">Noise / BS branch</div><strong>{phyResult.noisePowerDbm?.toFixed(1)} dBm</strong></div>
                <div><div className="text-slate-500">Noise bandwidth</div><strong>{((phyResult.noiseBandwidthHz ?? 0) / 1e6).toFixed(2)} MHz</strong></div>
                <div><div className="text-slate-500">BS receiver NF</div><strong>{phyResult.receiverNoiseFigureDb?.toFixed(1)} dB</strong></div>
                <div><div className="text-slate-500">Mean channel gain</div><strong>{phyResult.meanChannelGainDb?.toFixed(1)} dB</strong></div>
                <div><div className="text-slate-500">Mean link-budget SNR reference</div><strong>{phyResult.effectiveSnrDb?.toFixed(2)} dB</strong></div>
                <div><div className="text-slate-500">Approx. link-budget Eb/N0</div><strong>{phyResult.linkBudgetEbNoDb?.toFixed(2)} dB</strong></div>
              </div>
            )}
            {renderBerChart(phyResult)}
            <div className="text-[11px] text-slate-500 font-mono">
              Max excess delay {phyResult.maxExcessDelayNs.toFixed(1)} ns · approximate minimum CP {phyResult.approxMinimumCpNs.toFixed(1)} ns
              {phyResult.maxExcessDelayNs > phyResult.approxMinimumCpNs && (
                <span className="text-[#b45309]"> · Warning: excess delay may exceed the cyclic prefix; the frequency-domain model does not simulate resulting ISI/ICI.</span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] font-mono border-collapse">
                <thead><tr className="text-slate-500 border-b border-[#e3e0d6]">
                  <th className="text-left py-1.5 pr-2">Eb/N0</th><th className="text-right py-1.5 px-2">BER [95% CI]</th>
                  {phyResult.channelMode === 'absolute' && <th className="text-right py-1.5 px-2">Link offset</th>}
                  <th className="text-right py-1.5 px-2">BLER [95% CI]</th><th className="text-right py-1.5 pl-2">Goodput</th>
                </tr></thead>
                <tbody>{phyResult.points.map((p) => (
                  <tr key={p.ebNoDb} className="border-b border-[#eeeae1] text-slate-700">
                    <td className="py-1.5 pr-2">{p.ebNoDb.toFixed(2)} dB</td>
                    <td className="text-right py-1.5 px-2">{p.ber.toExponential(2)} [{p.berCi95Lower.toExponential(1)}, {p.berCi95Upper.toExponential(1)}]</td>
                    {phyResult.channelMode === 'absolute' && <td className="text-right py-1.5 px-2">{(p.linkBudgetOffsetDb ?? 0) > 0 ? '+' : ''}{(p.linkBudgetOffsetDb ?? 0).toFixed(1)} dB</td>}
                    <td className="text-right py-1.5 px-2">{p.bler.toExponential(2)} [{p.blerCi95Lower.toExponential(1)}, {p.blerCi95Upper.toExponential(1)}]</td>
                    <td className="text-right py-1.5 pl-2">{p.goodputMbps.toFixed(2)} Mbps</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <span className="text-[11px] text-slate-400 font-mono">BER/BLER intervals are Wilson 95% score intervals. Goodput is empirical decoded TB bits per simulated slot duration for this single UE link; it excludes scheduler, HARQ, control and core-network overhead. Open chart markers indicate no observed errors in the finite sample.</span>
          </>
        )}
      </div>

      {/* Coverage KPIs from the last Sionna radio map (served %, percentiles) */}
      {coverageStats && (
        <div className="bg-[#f5f3ec] border border-[#e3e0d6] rounded p-4 flex flex-col gap-2.5">
          <h4 className="eyebrow flex items-center gap-1.5">
            <Waves className="w-3.5 h-3.5 text-[#4a727e]" /> Coverage KPIs · {coverageStats.metric === 'sinr' ? 'SINR' : 'Received Power'}
          </h4>
          <div className="flex items-center justify-between text-[14px] border-b border-[#ebe7dc] py-1.5">
            <span className="text-slate-600">Served (≥ {coverageStats.thresholdDb.toFixed(0)} {coverageStats.unit})</span>
            <span className="font-bold font-mono text-[#5f7f5a]">{coverageStats.servedPercent.toFixed(1)}%</span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            {([['Cell-edge p5', coverageStats.p5], ['Median p50', coverageStats.p50], ['Peak p95', coverageStats.p95]] as const).map(([lab, val]) => (
              <div key={lab} className="flex flex-col gap-0.5 bg-white border border-[#e3e0d6] rounded py-2">
                <span className="text-[11px] text-slate-500 font-bold">{lab}</span>
                <span className="font-mono text-[14px] font-bold text-slate-800">{val.toFixed(1)}</span>
                <span className="text-[11px] text-slate-400">{coverageStats.unit}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Warnings & Help constraints */}
      {metrics.totalRxPowerDbm < -95 && (
        <div className="bg-[#f8f1ec] border border-[#e8d3c2] rounded p-3 text-[14px] text-slate-700 flex items-start gap-2.5 shadow-sm">
          <AlertCircle className="w-4 h-4 text-[#cc785c] shrink-0 mt-0.5" />
          <div>
            <strong className="text-slate-900">Fading Warning:</strong> Receiver node is inside a Severe Deep Fade zone ({metrics.totalRxPowerDbm.toFixed(1)} dBm).
            Consider shifting the Transmitter elevation beam, increasing power dBm, or lowering the carrier frequency to channel reflections successfully.
          </div>
        </div>
      )}
    </div>
  );
}
