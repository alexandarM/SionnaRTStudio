/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * On-demand PathSolver analysis for selected cells in a cached radio map.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Copy, Crosshair, ExternalLink, Loader2, MapPin, Waves } from 'lucide-react';
import {
  getRadioMapSampleCells,
  RadioMapChannelAnalysisResponse,
  RadioMapSampleCell,
  runRadioMapChannelAnalysis,
} from '../api';
import { safeCreateExperiment, sha256Json, summarizeUnknownExperimentResult } from '../lib/experimentLogging';
import { GeoAnchor, RadioMapGrid, Receiver } from '../types';
import { enuToLatLon } from '../utils';

interface ChannelAnalysisPanelProps {
  radioMap: RadioMapGrid;
  rx: Receiver;
  anchor: GeoAnchor;
  candidateScope: 'all' | 'rss_serving' | 'sinr_serving';
  selectionMode: 'strict_topk' | 'spatially_distributed';
  onFocusCell: (cellIndex: number) => void;
}

type SampleCriterion = 'weak_sinr' | 'weak_rss' | 'strong_interference';
type TxMode = 'serving' | 'serving_and_interferer' | 'selected' | 'all';

const MAX_SELECTED_CELLS = 12;

function fmt(value: number | null | undefined, digits = 1, suffix = ''): string {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}${suffix}`;
}

function cfrPolyline(values: (number | null)[], width = 320, height = 92): string {
  const finite = values.map((value, index) => ({ value, index })).filter((item) => item.value != null && Number.isFinite(item.value));
  if (finite.length < 2) return '';
  const min = Math.min(...finite.map((item) => item.value as number));
  const max = Math.max(...finite.map((item) => item.value as number));
  const span = Math.max(max - min, 1e-9);
  return finite.map(({ value, index }) => {
    const x = 8 + (index / Math.max(values.length - 1, 1)) * (width - 16);
    const y = height - 8 - (((value as number) - min) / span) * (height - 20);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

export function ChannelAnalysisPanel({ radioMap, rx, anchor, candidateScope, selectionMode, onFocusCell }: ChannelAnalysisPanelProps) {
  const [criterion, setCriterion] = useState<SampleCriterion>('weak_sinr');
  const [sectorIndex, setSectorIndex] = useState(0);
  const [txMode, setTxMode] = useState<TxMode>('serving_and_interferer');
  const [candidates, setCandidates] = useState<RadioMapSampleCell[]>([]);
  const [selectedCells, setSelectedCells] = useState<number[]>([]);
  const [manualCellIndex, setManualCellIndex] = useState('');
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RadioMapChannelAnalysisResponse | null>(null);
  const [numSubcarriers, setNumSubcarriers] = useState(64);
  const [copyFeedback, setCopyFeedback] = useState('');

  useEffect(() => {
    setCandidates([]);
    setSelectedCells([]);
    setResult(null);
    setError('');
    setSectorIndex(0);
  }, [radioMap.mapId, candidateScope, selectionMode]);

  const selectedCandidateRows = useMemo(
    () => selectedCells.map((index) => candidates.find((item) => item.cellIndex === index)
      ?? (() => {
        const cell = radioMap.cells[index];
        return cell ? {
          cellIndex: index, x: cell.x, y: cell.y, z: cell.z,
          rssDbm: cell.powerDbm, sinrDb: cell.sinr ?? null,
          interferenceDbm: cell.interferencePowerDbm ?? null, snrDb: null,
        } : null;
      })()).filter((item): item is RadioMapSampleCell => item != null),
    [selectedCells, candidates, radioMap.cells],
  );

  const loadCandidates = async () => {
    if (!radioMap.mapId) return;
    setLoadingCandidates(true);
    setError('');
    try {
      const rows = await getRadioMapSampleCells(
        radioMap.mapId, sectorIndex, criterion, 16, candidateScope, selectionMode,
      );
      setCandidates(rows);
      setSelectedCells(rows.slice(0, Math.min(4, MAX_SELECTED_CELLS)).map((row) => row.cellIndex));
      setResult(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load candidate radio-map cells');
    } finally {
      setLoadingCandidates(false);
    }
  };

  const toggleCell = (cellIndex: number) => {
    setSelectedCells((current) => {
      if (current.includes(cellIndex)) return current.filter((index) => index !== cellIndex);
      if (current.length >= MAX_SELECTED_CELLS) {
        setError(`A maximum of ${MAX_SELECTED_CELLS} locations can be analysed in one batch.`);
        return current;
      }
      setError('');
      return [...current, cellIndex];
    });
  };

  const addManualCell = () => {
    const index = Number(manualCellIndex);
    if (!Number.isInteger(index) || index < 0 || index >= radioMap.cells.length) {
      setError(`Enter a valid cell index from 0 to ${Math.max(0, radioMap.cells.length - 1)}.`);
      return;
    }
    if (!selectedCells.includes(index)) toggleCell(index);
    setManualCellIndex('');
  };

  const runAnalysis = async () => {
    if (!radioMap.mapId || selectedCells.length === 0) return;
    const startedAtUtc = new Date().toISOString();
    const started = performance.now();
    const requestBody = { cellIndices: selectedCells, txMode, txIndex: sectorIndex, rxArraySize: rx.antennaArraySize, numSubcarriers, subcarrierSpacingHz: 30_000, pathsToReturn: 24 };
    const configuration = {
      radioMap: { mapId: radioMap.mapId, cellCount: radioMap.cells.length, metric: radioMap.metric, geoReference: radioMap.geoReference },
      receiver: rx, anchor, candidateScope, selectionMode,
      request: requestBody,
    };
    setRunning(true);
    setError('');
    try {
      const response = await runRadioMapChannelAnalysis(
        radioMap.mapId, selectedCells, txMode, rx.antennaArraySize, sectorIndex, numSubcarriers, 30_000, 24,
      );
      setResult(response);
      await safeCreateExperiment({
        name: `Channel analysis · ${selectedCells.length} cells · ${txMode}`, kind: 'channel_analysis', status: 'done',
        startedAtUtc, completedAtUtc: new Date().toISOString(), durationMs: performance.now() - started,
        seed: response.execution.seed, configuration, configurationFingerprint: await sha256Json(configuration),
        parameters: { ...requestBody, candidateScope, selectionMode, criterion, selectedCellCount: selectedCells.length },
        results: summarizeUnknownExperimentResult('channel_analysis', response),
        replay: { endpoint: `/api/radiomap/${encodeURIComponent(radioMap.mapId)}/channel-analysis`, body: requestBody, description: 'Repeat channel analysis for selected radio-map cells' },
      });
    } catch (err: any) {
      const errorText = err?.message || 'PathSolver channel analysis failed';
      setError(errorText);
      setResult(null);
      await safeCreateExperiment({
        name: `Channel analysis · ${selectedCells.length} cells · ${txMode}`, kind: 'channel_analysis', status: 'error',
        startedAtUtc, completedAtUtc: new Date().toISOString(), durationMs: performance.now() - started,
        configuration, configurationFingerprint: await sha256Json(configuration), parameters: { ...requestBody, candidateScope, selectionMode, criterion }, results: {}, error: errorText,
        replay: { endpoint: `/api/radiomap/${encodeURIComponent(radioMap.mapId)}/channel-analysis`, body: requestBody, description: 'Retry channel analysis for selected radio-map cells' },
      });
    } finally {
      setRunning(false);
    }
  };

  const txModeDescription: Record<TxMode, string> = {
    serving: 'Only each cell’s RSS-serving sector is traced.',
    serving_and_interferer: 'Traces the RSS-serving sector and strongest non-serving interferer for each selected cell.',
    selected: 'Traces the selected sector to every selected location.',
    all: 'Traces every co-channel sector to every selected location (subject to the batch limit).',
  };

  const getGeolocation = (x: number, y: number, z: number) =>
    enuToLatLon({ x, y, z }, radioMap.geoReference?.anchor ?? anchor);
  const googleMapsUrl = (x: number, y: number, z: number) => {
    const geo = getGeolocation(x, y, z);
    return `https://www.google.com/maps/search/?api=1&query=${geo.lat.toFixed(7)},${geo.lon.toFixed(7)}`;
  };
  const copyCoordinates = async (x: number, y: number, z: number) => {
    const geo = getGeolocation(x, y, z);
    const value = `${geo.lat.toFixed(7)}, ${geo.lon.toFixed(7)}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('Clipboard access is unavailable');
      }
      setCopyFeedback(`Copied ${value}`);
    } catch {
      setCopyFeedback('Could not access clipboard. Copy the coordinates shown on the card.');
    }
  };
  const openGoogleMaps = (x: number, y: number, z: number) => {
    window.open(googleMapsUrl(x, y, z), '_blank', 'noopener,noreferrer');
  };

  return (
    <section className="flex flex-col gap-3 rounded border border-[#cfc8b9] bg-[#f5f3ec] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#4a727e]" />
          <div>
            <div className="text-[12px] font-bold text-slate-800">Channel Analysis</div>
            <div className="text-[10px] text-slate-500">Selected radio-map cells → one batched Sionna PathSolver pass</div>
          </div>
        </div>
        <span className="rounded border border-[#d8d4c8] bg-white px-2 py-1 text-[9px] font-semibold text-slate-600">
          {radioMap.cells.length.toLocaleString()} map cells
        </span>
      </div>

      {!radioMap.mapId && <p className="text-[10px] text-amber-800">The radio-map cache is unavailable. Recompute the coverage map before starting channel analysis.</p>}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-[10px] font-semibold text-slate-600">
          Candidate sector
          <select value={sectorIndex} onChange={(event) => setSectorIndex(Number(event.target.value))} className="rounded border border-[#d8d4c8] bg-white px-2 py-1.5 text-[11px] font-normal text-slate-800">
            {(radioMap.txStats ?? []).map((tx) => <option key={tx.txIndex} value={tx.txIndex}>{tx.txName}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-semibold text-slate-600">
          Automatic candidate criterion
          <select value={criterion} onChange={(event) => setCriterion(event.target.value as SampleCriterion)} className="rounded border border-[#d8d4c8] bg-white px-2 py-1.5 text-[11px] font-normal text-slate-800">
            <option value="weak_sinr">Weakest SINR</option>
            <option value="weak_rss">Weakest RSS</option>
            <option value="strong_interference">Highest interference</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-semibold text-slate-600">
          Tx links to trace
          <select value={txMode} onChange={(event) => setTxMode(event.target.value as TxMode)} className="rounded border border-[#d8d4c8] bg-white px-2 py-1.5 text-[11px] font-normal text-slate-800">
            <option value="serving_and_interferer">Serving + dominant interferer</option>
            <option value="serving">Serving sector only</option>
            <option value="selected">Selected sector only</option>
            <option value="all">All co-channel sectors</option>
          </select>
        </label>
      </div>
      <p className="text-[9px] text-slate-500">{txModeDescription[txMode]} The same carrier, scene geometry, transmitter configuration, materials and interaction switches used for the cached map are replayed by the backend.</p>
      <p className="text-[9px] text-slate-500">Candidate scope: <b>{candidateScope === 'all' ? 'all map cells' : candidateScope === 'rss_serving' ? 'RSS-serving footprint of selected sector' : 'best-SINR footprint of selected sector'}</b> · Ranking: <b>{selectionMode === 'strict_topk' ? 'strict Top-K' : 'spatially distributed sample'}</b>. Choose “Selected sector only” above when you want the chosen candidate sector itself traced even if it is not the RSS-serving sector.</p>
      {!radioMap.geoReference && <p className="rounded border border-amber-200 bg-amber-50 p-2 text-[9px] text-amber-900">No georeference snapshot was stored with this map. Google Maps coordinates use the current scene anchor; verify that the anchor matches the map's actual WGS84 origin.</p>}

      <div className="flex flex-wrap items-end gap-2">
        <button type="button" onClick={() => void loadCandidates()} disabled={!radioMap.mapId || loadingCandidates || running} className="inline-flex items-center gap-1.5 rounded border border-[#b9c8c8] bg-white px-3 py-2 text-[10px] font-bold text-slate-700 disabled:opacity-40">
          {loadingCandidates ? <Loader2 className="h-3 w-3 animate-spin" /> : <Crosshair className="h-3 w-3" />}
          {loadingCandidates ? 'Selecting…' : 'Find candidate locations'}
        </button>
        <div className="flex items-end gap-1">
          <label className="flex flex-col gap-1 text-[9px] font-semibold text-slate-500">Manual map cell index
            <input type="number" min="0" max={radioMap.cells.length - 1} value={manualCellIndex} onChange={(event) => setManualCellIndex(event.target.value)} placeholder="e.g. 125" className="w-24 rounded border border-[#d8d4c8] bg-white px-2 py-2 text-[10px] font-normal text-slate-800" />
          </label>
          <button type="button" onClick={addManualCell} disabled={manualCellIndex.trim() === '' || selectedCells.length >= MAX_SELECTED_CELLS} className="rounded border border-[#d8d4c8] bg-white px-3 py-2 text-[10px] font-bold text-slate-700 disabled:opacity-40">Add</button>
        </div>
        <label className="ml-auto flex flex-col gap-1 text-[9px] font-semibold text-slate-500">CFR subcarriers
          <select value={numSubcarriers} onChange={(event) => setNumSubcarriers(Number(event.target.value))} className="rounded border border-[#d8d4c8] bg-white px-2 py-2 text-[10px] font-normal text-slate-800">
            <option value={64}>64</option><option value={128}>128</option><option value={256}>256</option>
          </select>
        </label>
      </div>

      {candidates.length > 0 && (
        <div className="rounded border border-[#e0dbcf] bg-white p-2">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] font-bold text-slate-700">Candidate locations · choose up to {MAX_SELECTED_CELLS}</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setSelectedCells(candidates.slice(0, MAX_SELECTED_CELLS).map((item) => item.cellIndex))} className="text-[9px] font-semibold text-[#4a727e]">Select visible</button>
              <button type="button" onClick={() => setSelectedCells([])} className="text-[9px] font-semibold text-slate-500">Clear</button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {candidates.map((cell) => {
              const geo = getGeolocation(cell.x, cell.y, cell.z);
              return (
                <div key={cell.cellIndex} className={`flex flex-col gap-1.5 rounded border p-2 ${selectedCells.includes(cell.cellIndex) ? 'border-[#a7b9b4] bg-[#eef3f0]' : 'border-[#eeeae2] bg-[#fbfaf7]'}`}>
                  <div className="flex items-center gap-2">
                    <input aria-label={`Select cell ${cell.cellIndex}`} type="checkbox" checked={selectedCells.includes(cell.cellIndex)} onChange={() => toggleCell(cell.cellIndex)} disabled={!selectedCells.includes(cell.cellIndex) && selectedCells.length >= MAX_SELECTED_CELLS} className="accent-[#4a727e]" />
                    <span className="min-w-0 flex-1"><b className="font-mono text-slate-800">Cell #{cell.cellIndex}</b><span className="ml-1 font-mono text-slate-500">{fmt(cell.sinrDb, 1, ' dB')} SINR</span></span>
                  </div>
                  <div className="pl-5 font-mono text-[8px] text-slate-500">ENU {cell.x.toFixed(2)}, {cell.y.toFixed(2)}, {cell.z.toFixed(2)} m</div>
                  <div className="pl-5 font-mono text-[8px] font-semibold text-slate-700">{geo.lat.toFixed(7)}, {geo.lon.toFixed(7)}</div>
                  <div className="flex flex-wrap gap-1 pl-5">
                    <button type="button" onClick={() => onFocusCell(cell.cellIndex)} className="inline-flex items-center gap-1 rounded border border-[#d8d4c8] bg-white px-2 py-1 text-[8px] font-semibold text-slate-700"><MapPin className="h-3 w-3" /> Mark in 3D</button>
                    <button type="button" onClick={() => openGoogleMaps(cell.x, cell.y, cell.z)} className="inline-flex items-center gap-1 rounded border border-[#d8d4c8] bg-white px-2 py-1 text-[8px] font-semibold text-slate-700"><ExternalLink className="h-3 w-3" /> Google Maps</button>
                    <button type="button" onClick={() => void copyCoordinates(cell.x, cell.y, cell.z)} className="inline-flex items-center gap-1 rounded border border-[#d8d4c8] bg-white px-2 py-1 text-[8px] font-semibold text-slate-700"><Copy className="h-3 w-3" /> Copy</button>
                  </div>
                </div>
              );
            })}
          </div>
          {copyFeedback && <div className="pt-1 text-[8px] text-emerald-700">{copyFeedback}</div>}
        </div>
      )}

      {selectedCells.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[9px] text-slate-600">
          <span>{selectedCells.length} location(s) selected: {selectedCandidateRows.map((item) => `#${item.cellIndex}`).join(', ')}</span>
          <span>Rx array: {rx.antennaArraySize[0]} × {rx.antennaArraySize[1]}</span>
        </div>
      )}

      {error && <p className="rounded border border-red-200 bg-red-50 p-2 text-[10px] text-red-700">{error}</p>}

      <button type="button" onClick={() => void runAnalysis()} disabled={!radioMap.mapId || selectedCells.length === 0 || running || loadingCandidates} className="inline-flex items-center justify-center gap-2 rounded bg-[#344f58] px-3 py-2.5 text-[11px] font-bold text-white hover:bg-[#263e46] disabled:cursor-not-allowed disabled:opacity-40">
        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Waves className="h-4 w-4" />}
        {running ? 'Running batched PathSolver…' : `Analyse ${selectedCells.length || 0} selected location(s)`}
      </button>

      {result && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded border border-[#e0dbcf] bg-white p-2"><div className="text-[9px] text-slate-500">PathSolver dispatches</div><div className="font-mono text-[15px] font-bold">{result.execution.pathSolverDispatches}</div></div>
            <div className="rounded border border-[#e0dbcf] bg-white p-2"><div className="text-[9px] text-slate-500">Traced Tx–Rx pairs</div><div className="font-mono text-[15px] font-bold">{result.execution.tracedTxRxPairs}</div></div>
            <div className="rounded border border-[#e0dbcf] bg-white p-2"><div className="text-[9px] text-slate-500">Returned links</div><div className="font-mono text-[15px] font-bold">{result.execution.returnedLinks}</div></div>
            <div className="rounded border border-[#e0dbcf] bg-white p-2"><div className="text-[9px] text-slate-500">Solver time</div><div className="font-mono text-[15px] font-bold">{(result.execution.solveTimeMs / 1000).toFixed(2)} s</div></div>
          </div>
          <p className="text-[9px] text-slate-500">{result.frequencyGhz.toFixed(4)} GHz · max depth {result.maxDepth} · {result.numSubcarriers} CFR subcarriers · {result.execution.samplesPerSource.toLocaleString()} samples/source · {result.execution.estimatedCfrComplexSamples.toLocaleString()} CFR elements · seed {result.execution.seed}</p>

          {result.locations.map((location) => (
            <article key={location.cellIndex} className="flex flex-col gap-2 rounded border border-[#d8d4c8] bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] font-bold text-slate-800">Map cell #{location.cellIndex}</div>
                <span className="font-mono text-[9px] text-slate-500">ENU ({location.positionEnuM.x.toFixed(2)}, {location.positionEnuM.y.toFixed(2)}, {location.positionEnuM.z.toFixed(2)}) m</span>
              </div>
              {(() => {
                const geo = getGeolocation(location.positionEnuM.x, location.positionEnuM.y, location.positionEnuM.z);
                return (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-sky-100 bg-sky-50 p-2">
                    <div className="font-mono text-[9px] font-semibold text-sky-900">WGS84 {geo.lat.toFixed(7)}, {geo.lon.toFixed(7)}</div>
                    <div className="flex gap-1">
                      <button type="button" onClick={() => onFocusCell(location.cellIndex)} className="rounded border border-sky-200 bg-white px-2 py-1 text-[8px] font-semibold text-sky-900">Mark in 3D</button>
                      <button type="button" onClick={() => openGoogleMaps(location.positionEnuM.x, location.positionEnuM.y, location.positionEnuM.z)} className="rounded border border-sky-200 bg-white px-2 py-1 text-[8px] font-semibold text-sky-900">Google Maps</button>
                      <button type="button" onClick={() => void copyCoordinates(location.positionEnuM.x, location.positionEnuM.y, location.positionEnuM.z)} className="rounded border border-sky-200 bg-white px-2 py-1 text-[8px] font-semibold text-sky-900">Copy</button>
                    </div>
                  </div>
                );
              })()}
              <div className="text-[9px] text-slate-500">Radio-map serving sector: {location.radioMap.servingTxName ?? 'none'} · RSS {fmt(location.radioMap.rssDbm, 1, ' dBm')} · top interferer index {location.radioMap.topInterfererTxIndex ?? '—'}</div>
              {location.links.map((link) => {
                const tapPoints = link.cirTaps.filter((tap) => tap.receivedPowerDbm != null);
                const maxTap = Math.max(...tapPoints.map((tap) => tap.receivedPowerDbm as number), -200);
                const minTap = Math.min(...tapPoints.map((tap) => tap.receivedPowerDbm as number), maxTap - 1);
                const cfrLine = cfrPolyline(link.cfr.magnitudeDb);
                return (
                  <div key={`${location.cellIndex}-${link.txId}`} className="flex flex-col gap-2 rounded border border-[#eeeae2] bg-[#fbfaf7] p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-[10px] font-bold text-slate-800">{link.txName} <span className="ml-1 rounded bg-[#e9eee9] px-1.5 py-0.5 text-[8px] font-semibold text-[#44645c]">{link.role.replaceAll('_', ' ')}</span></div>
                      <div className="text-[9px] text-slate-500">{link.channelMetrics.losStatus} · {link.channelMetrics.numPaths} paths · {fmt(link.channelMetrics.totalRxPowerDbm, 1, ' dBm')}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
                      <div className="rounded bg-white p-1.5"><div className="text-[8px] text-slate-500">RMS delay spread</div><div className="font-mono text-[11px] font-bold">{fmt(link.channelMetrics.rmsDelaySpreadNs, 2, ' ns')}</div></div>
                      <div className="rounded bg-white p-1.5"><div className="text-[8px] text-slate-500">K-factor</div><div className="font-mono text-[11px] font-bold">{fmt(link.kFactorDb, 2, ' dB')}</div>{link.kFactorNote && <div className="text-[8px] text-slate-400">{link.kFactorNote}</div>}</div>
                      <div className="rounded bg-white p-1.5"><div className="text-[8px] text-slate-500">Strongest path</div><div className="text-[10px] font-semibold">{link.channelMetrics.strongestPathType}</div></div>
                      <div className="rounded bg-white p-1.5"><div className="text-[8px] text-slate-500">Max |Doppler|</div><div className="font-mono text-[11px] font-bold">{fmt(link.maxDopplerHz, 2, ' Hz')}</div></div>
                    </div>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      <div className="rounded border border-[#eeeae2] bg-white p-2">
                        <div className="mb-1 text-[9px] font-bold text-slate-600">CIR · path-resolved taps</div>
                        {tapPoints.length > 0 ? (
                          <svg viewBox="0 0 320 98" className="h-24 w-full" role="img" aria-label={`CIR delay profile for ${link.txName}`}>
                            <line x1="8" y1="86" x2="312" y2="86" stroke="#cbd5e1" />
                            {tapPoints.map((tap) => {
                              const x = 8 + (tap.delayNs / Math.max(...tapPoints.map((item) => item.delayNs), 1)) * 304;
                              const y = 10 + ((maxTap - (tap.receivedPowerDbm as number)) / Math.max(maxTap - minTap, 1)) * 70;
                              return <g key={tap.pathIndex}><line x1={x} y1="86" x2={x} y2={y} stroke="#4a727e" strokeWidth="1.5"/><circle cx={x} cy={y} r="2.5" fill="#cc785c"><title>{`Path ${tap.pathIndex}: ${tap.delayNs.toFixed(2)} ns, ${(tap.receivedPowerDbm as number).toFixed(2)} dBm`}</title></circle></g>;
                            })}
                            <text x="8" y="96" fontSize="8" fill="#64748b">0 ns</text><text x="280" y="96" fontSize="8" fill="#64748b">delay</text>
                          </svg>
                        ) : <div className="py-8 text-center text-[9px] text-slate-400">No valid CIR taps returned.</div>}
                      </div>
                      <div className="rounded border border-[#eeeae2] bg-white p-2">
                        <div className="mb-1 text-[9px] font-bold text-slate-600">CFR · magnitude across subcarriers</div>
                        {cfrLine ? <svg viewBox="0 0 320 92" className="h-24 w-full" role="img" aria-label={`CFR magnitude for ${link.txName}`}><line x1="8" y1="82" x2="312" y2="82" stroke="#cbd5e1"/><polyline fill="none" stroke="#cc785c" strokeWidth="2" points={cfrLine}/></svg> : <div className="py-8 text-center text-[9px] text-slate-400">No finite CFR magnitude.</div>}
                        <div className="text-[8px] text-slate-500">{link.cfr.phaseAvailable ? 'Phase: native scalar phase shown in API result.' : link.cfr.phaseNote}</div>
                      </div>
                    </div>
                    <div className="overflow-x-auto rounded border border-[#eeeae2] bg-white">
                      <table className="w-full text-[9px]"><thead><tr className="border-b text-left text-slate-500"><th className="p-1.5">Path</th><th>Type</th><th>Delay</th><th>Power</th><th>AoD az/el</th><th>AoA az/el</th><th>Interactions</th></tr></thead><tbody>
                        {link.paths.slice(0, 8).map((path) => <tr key={path.id} className="border-b border-slate-100"><td className="p-1.5 font-mono">{path.id}</td><td>{path.type}</td><td className="font-mono">{fmt(path.delayNs, 2, ' ns')}</td><td className="font-mono">{fmt(path.receivedPowerDbm, 1, ' dBm')}</td><td className="font-mono">{fmt(path.aodAzimuthDeg, 1)} / {fmt(path.aodElevationDeg, 1)}</td><td className="font-mono">{fmt(path.aoaAzimuthDeg, 1)} / {fmt(path.aoaElevationDeg, 1)}</td><td>{path.interactionKinds?.join(', ') || (path.order === 0 ? 'direct' : '—')}</td></tr>)}
                      </tbody></table>
                    </div>
                  </div>
                );
              })}
              {location.links.length === 0 && <p className="text-[9px] text-amber-700">No associated TX was selected for this location.</p>}
            </article>
          ))}
          <p className="text-[9px] leading-relaxed text-slate-500">{result.interpretation.los} {result.interpretation.kFactor} {result.interpretation.cfr}</p>
        </div>
      )}
    </section>
  );
}
