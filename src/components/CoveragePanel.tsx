// Modified in the alexandarM/SionnaRTStudio fork of puloktarafder/SionnaRTStudio.
// Upstream: https://github.com/puloktarafder/SionnaRTStudio

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { RadioMapGrid, CoverageMetric, SectorAnalysisResponse, DominantInterferenceMatrix, Receiver, GeoAnchor, Transmitter } from '../types';
import { ColormapName, COLORMAP_NAMES, colormapCssGradient } from '../lib/colormaps';
import { Waves, Activity, Navigation, Download, Info } from 'lucide-react';
import { NumberField } from './NumberField';
import { ChannelAnalysisPanel } from './ChannelAnalysisPanel';
import { downloadRadioMapTxCsv, getRadioMapSectorAnalysis, getRadioMapInterferenceMatrix, getRadioMapSampleCells } from '../api';
import { enuToLatLon } from '../utils';
import { CellAssociationMap, AssociationLayer } from './CellAssociationMap';

interface CoveragePanelProps {
  txCount: number;
  rx: Receiver;
  bandOptions: string[];
  selectedBand: string;
  onSelectBand: (band: string) => void;
  backendOnline: boolean;
  onRunHeatmap: (resolution: number, height: number, samplesPerTx: number, seed: number) => void;
  heatmapLoading: boolean;
  radioMap: RadioMapGrid | null;
  anchor: GeoAnchor;
  txs: Transmitter[];
  onFocusCell: (cellIndex: number) => void;
  focusedRadioMapCellIndex: number | null;
  coverageMetric: CoverageMetric;
  setCoverageMetric: (m: CoverageMetric) => void;
  coverageThresholdDb: number;
  setCoverageThresholdDb: (v: number) => void;
  coverageBandwidthMhz: number;
  setCoverageBandwidthMhz: (v: number) => void;
  coverageNoiseFigureDb: number;
  setCoverageNoiseFigureDb: (v: number) => void;
  coverageHeight: number;
  setCoverageHeight: (v: number) => void;
  coverageRes: number;
  setCoverageRes: (v: number) => void;
  samplesPerTx: number;
  setSamplesPerTx: (v: number) => void;
  radioMapSeed: number;
  setRadioMapSeed: (v: number) => void;
  showRaysOnHeatmap: boolean;
  setShowRaysOnHeatmap: (v: boolean) => void;
  rmColormap: ColormapName;
  setRmColormap: (c: ColormapName) => void;
  rmAutoRange: boolean;
  setRmAutoRange: (v: boolean) => void;
  rmVmin: number;
  setRmVmin: (v: number) => void;
  rmVmax: number;
  setRmVmax: (v: number) => void;
  solveError: string;
}

// RADIO COVERAGE VIEWPORT — Sionna RadioMapSolver controls, display, KPIs.
export function CoveragePanel({
  txCount,
  rx,
  bandOptions,
  selectedBand,
  onSelectBand,
  backendOnline,
  onRunHeatmap,
  heatmapLoading,
  radioMap,
  anchor,
  txs,
  onFocusCell,
  focusedRadioMapCellIndex,
  coverageMetric,
  setCoverageMetric,
  coverageThresholdDb,
  setCoverageThresholdDb,
  coverageBandwidthMhz,
  setCoverageBandwidthMhz,
  coverageNoiseFigureDb,
  setCoverageNoiseFigureDb,
  coverageHeight,
  setCoverageHeight,
  coverageRes,
  setCoverageRes,
  samplesPerTx,
  setSamplesPerTx,
  radioMapSeed,
  setRadioMapSeed,
  showRaysOnHeatmap,
  setShowRaysOnHeatmap,
  rmColormap,
  setRmColormap,
  rmAutoRange,
  setRmAutoRange,
  rmVmin,
  setRmVmin,
  rmVmax,
  setRmVmax,
  solveError,
}: CoveragePanelProps) {
  const coverageStats = radioMap?.stats ?? null;
  const [exportingTx, setExportingTx] = useState<number | null>(null);
  const [selectedSector, setSelectedSector] = useState(0);
  const [sectorReport, setSectorReport] = useState<SectorAnalysisResponse | null>(null);
  const [sectorLoading, setSectorLoading] = useState(false);
  const [sectorError, setSectorError] = useState('');
  const [interferenceMatrix, setInterferenceMatrix] = useState<DominantInterferenceMatrix | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixError, setMatrixError] = useState('');
  const [sampleExporting, setSampleExporting] = useState<string | null>(null);
  const [sectorDistributionMetric, setSectorDistributionMetric] = useState('sinr');
  const [associationLayer, setAssociationLayer] = useState<AssociationLayer>('rss');
  const [candidateScope, setCandidateScope] = useState<'all' | 'rss_serving' | 'sinr_serving'>('rss_serving');
  const [selectionMode, setSelectionMode] = useState<'strict_topk' | 'spatially_distributed'>('strict_topk');

  useEffect(() => {
    setSelectedSector(0);
    setSectorReport(null);
    setSectorError('');
    setSectorDistributionMetric('sinr');
    setInterferenceMatrix(null);
    setMatrixError('');
  }, [radioMap?.mapId]);

  const loadSectorReport = async (index = selectedSector) => {
    if (!radioMap?.mapId) return;
    setSectorLoading(true);
    setSectorError('');
    try {
      const result = await getRadioMapSectorAnalysis(radioMap.mapId, index);
      setSectorReport(result);
      setSelectedSector(index);
    } catch (error: any) {
      setSectorError(error?.message || 'Sector analysis could not be loaded');
    } finally {
      setSectorLoading(false);
    }
  };

  const loadInterferenceMatrix = async () => {
    if (!radioMap?.mapId) return;
    setMatrixLoading(true);
    setMatrixError('');
    try {
      setInterferenceMatrix(await getRadioMapInterferenceMatrix(radioMap.mapId, 3));
    } catch (error: any) {
      setMatrixError(error?.message || 'Interference matrix could not be loaded');
    } finally {
      setMatrixLoading(false);
    }
  };

  const exportSectorSamples = async (criterion: 'weak_sinr' | 'weak_rss' | 'strong_interference') => {
    if (!radioMap?.mapId) return;
    setSampleExporting(criterion);
    try {
      const rows = await getRadioMapSampleCells(
        radioMap.mapId, selectedSector, criterion, 200, candidateScope, selectionMode,
      );
      const mapAnchor = radioMap.geoReference?.anchor ?? anchor;
      const headings = [
        'cell_index', 'tx_index', 'tx_name', 'criterion', 'association_scope', 'selection_mode',
        'x_enu_m', 'y_enu_m', 'z_enu_m', 'latitude_wgs84', 'longitude_wgs84', 'google_maps_url',
        'rss_dbm', 'sinr_db', 'snr_db', 'interference_dbm',
      ];
      const escapeCsv = (value: string | number | null | undefined) => {
        const text = value == null ? '' : String(value);
        return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      };
      const values = rows.map((row) => {
        const geo = enuToLatLon({ x: row.x, y: row.y, z: row.z }, mapAnchor);
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${geo.lat.toFixed(7)},${geo.lon.toFixed(7)}`;
        const txName = radioMap.txStats?.find((item) => item.txIndex === selectedSector)?.txName ?? `TX ${selectedSector + 1}`;
        return [
          row.cellIndex, selectedSector, txName, criterion, candidateScope, selectionMode,
          row.x, row.y, row.z, geo.lat.toFixed(7), geo.lon.toFixed(7), mapsUrl,
          row.rssDbm, row.sinrDb, row.snrDb, row.interferenceDbm,
        ].map(escapeCsv).join(',');
      });
      const csv = [
        `# Coordinate reference: WGS84 geographic (EPSG:4326); scene ENU anchor: ${mapAnchor.latitude}, ${mapAnchor.longitude}`,
        '# Geolocation is a local WGS84 tangent-plane conversion; correctness depends on the scene anchor being georeferenced correctly.',
        headings.join(','),
        ...values,
      ].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const downloadLink = document.createElement('a');
      downloadLink.href = url;
      downloadLink.download = `radiomap_tx${selectedSector}_${criterion}_${candidateScope}_${selectionMode}_geolocated.csv`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error: any) {
      setSectorError(error?.message || 'Sample export failed');
    } finally {
      setSampleExporting(null);
    }
  };
  const exportTx = async (index: number) => {
    if (!radioMap?.mapId) return;
    setExportingTx(index);
    try {
      const result = await downloadRadioMapTxCsv(radioMap.mapId, index);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Radio-map export failed', error);
    } finally {
      setExportingTx(null);
    }
  };
  const sectorDistributionLabels: Record<string, { label: string; unit: string }> = {
    rss: { label: 'Received power (RSS)', unit: 'dBm' },
    pathGain: { label: 'Path gain', unit: 'dB' },
    sinr: { label: 'Network SINR', unit: 'dB' },
    snr: { label: 'Isolated SNR', unit: 'dB' },
    interference: { label: 'Interference power', unit: 'dBm' },
    sir: { label: 'SIR', unit: 'dB' },
    inr: { label: 'INR', unit: 'dB' },
  };
  const sectorDistribution = sectorReport?.summaries[sectorDistributionMetric];
  const focusedCell = focusedRadioMapCellIndex == null ? null : radioMap?.cells[focusedRadioMapCellIndex] ?? null;
  const mapGeoAnchor = radioMap?.geoReference?.anchor ?? anchor;
  const focusedCellGeo = focusedCell
    ? enuToLatLon({ x: focusedCell.x, y: focusedCell.y, z: focusedCell.z }, mapGeoAnchor)
    : null;
  const openFocusedCellInMaps = () => {
    if (!focusedCellGeo) return;
    const url = `https://www.google.com/maps/search/?api=1&query=${focusedCellGeo.lat.toFixed(7)},${focusedCellGeo.lon.toFixed(7)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  const copyFocusedCellCoordinates = async () => {
    if (!focusedCellGeo) return;
    const value = `${focusedCellGeo.lat.toFixed(7)}, ${focusedCellGeo.lon.toFixed(7)}`;
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
      setSectorError('');
    } catch {
      setSectorError(`Copy is unavailable in this browser context. Coordinates: ${value}`);
    }
  };
  const exportGeolocatedRadioMap = () => {
    if (!radioMap) return;
    const mapAnchor = radioMap.geoReference?.anchor ?? anchor;
    const csvValue = (value: string | number | null | undefined) => {
      const text = value == null ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const headers = [
      'cell_index', 'x_enu_m', 'y_enu_m', 'z_enu_m', 'latitude_wgs84', 'longitude_wgs84', 'google_maps_url',
      'rss_dbm', 'serving_sinr_db', 'best_sinr_db', 'path_gain_db', 'interference_dbm', 'sir_db', 'inr_db',
      'rss_serving_tx_index', 'rss_serving_tx_name', 'best_sinr_tx_index', 'best_sinr_tx_name',
      'best_path_gain_tx_index', 'best_path_gain_tx_name', 'dominant_interferer_tx_index', 'dominant_interferer_tx_name',
    ];
    const txName = (index: number | null | undefined) => index == null
      ? '' : radioMap.txStats?.find((item) => item.txIndex === index)?.txName ?? `TX ${index + 1}`;
    const rows = radioMap.cells.map((cell, index) => {
      const geo = enuToLatLon({ x: cell.x, y: cell.y, z: cell.z }, mapAnchor);
      const mapUrl = `https://www.google.com/maps/search/?api=1&query=${geo.lat.toFixed(7)},${geo.lon.toFixed(7)}`;
      return [
        index, cell.x, cell.y, cell.z, geo.lat.toFixed(7), geo.lon.toFixed(7), mapUrl,
        cell.powerDbm, cell.sinr, cell.bestSinrDb, cell.pathGainDb, cell.interferencePowerDbm,
        cell.sirDb, cell.inrDb,
        cell.servingTx, txName(cell.servingTx), cell.bestSinrTx, txName(cell.bestSinrTx),
        cell.bestPathGainTx, txName(cell.bestPathGainTx), cell.topInterfererTx, txName(cell.topInterfererTx),
      ].map(csvValue).join(',');
    });
    const csv = [
      `# Coordinate reference: WGS84 geographic (EPSG:4326); scene ENU anchor: ${mapAnchor.latitude}, ${mapAnchor.longitude}`,
      '# Positions are local ENU-to-WGS84 tangent-plane conversions. Verify the scene anchor before interpreting ground truth.',
      headers.join(','), ...rows,
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = `radiomap_${radioMap.mapId ?? 'current'}_geolocated_cells.csv`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const metricLabels: Record<CoverageMetric, string> = {
    power: 'Received Power (RSS, dBm)',
    path_gain: 'Path Gain (dB)',
    path_loss: 'Effective Path Loss (dB)',
    sinr: 'Serving-cell SINR (dB)',
    best_sinr: 'Best available SINR (dB)',
    interference: 'Interference Power (dBm)',
    sir: 'SIR (dB)',
    inr: 'INR (dB)',
    dominance: 'Dominance Margin (dB)',
  };

  return (
    <div className="panel p-4 flex flex-col gap-4">
      <div className="flex items-center gap-1.5 justify-between">
        <div className="flex items-center gap-1.5">
          <Waves className="w-4 h-4 text-[#cc785c]" />
          <h3 className="panel-title">Coverage Solver</h3>
        </div>
        <span className="text-[11px] px-2 py-0.5 rounded font-bold border bg-[#ebe7dc] border-[#e3e0d6] text-slate-600">
          {txCount > 1 ? `Best-server · ${txCount} Tx` : 'Single Tx'}
        </span>
      </div>

      {bandOptions.length > 1 && (
        <div className="flex flex-col gap-1 rounded border border-amber-200 bg-amber-50 p-2">
          <label className="text-[11px] font-bold text-amber-900">Frequency Band group</label>
          <select
            value={selectedBand}
            onChange={(event) => onSelectBand(event.target.value)}
            className="rounded border border-amber-200 bg-white px-2 py-1.5 text-[12px] text-slate-800"
          >
            <option value="__all__">All bands (display only; solving disabled)</option>
            {bandOptions.map((band) => <option key={band} value={band}>{band}</option>)}
          </select>
          <p className="text-[10px] leading-relaxed text-amber-800">SionnaRTStudio currently solves one carrier frequency per scene. Select one band group and set its exact downlink carrier in RF Controls. Band names alone do not identify the deployed channel.</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3.5">
        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-slate-600 font-bold">Grid Height Offset: {coverageHeight}m</label>
          <input
            type="range"
            min="0.5"
            max="10"
            step="0.5"
            className="accent-[#cc785c] cursor-ew-resize"
            value={coverageHeight}
            onChange={(e) => setCoverageHeight(parseFloat(e.target.value))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[12px] text-slate-600 font-bold">Grid Step: {coverageRes}m</label>
          <input
            type="range"
            min="3"
            max="12"
            step="1"
            className="accent-[#cc785c] cursor-ew-resize"
            value={coverageRes}
            onChange={(e) => setCoverageRes(parseInt(e.target.value, 10))}
          />
        </div>
      </div>

      {/* Metric — interference-aware SINR vs. received power */}
      <div className="flex flex-col gap-1">
        <label className="text-[12px] text-slate-600 font-bold">Metric</label>
        <select
          id="select-coverage-metric"
          className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
          value={coverageMetric}
          onChange={(e) => setCoverageMetric(e.target.value as CoverageMetric)}
        >
          <option value="power">Received Power / RSS (dBm)</option>
          <option value="path_gain">Path Gain (dB)</option>
          <option value="path_loss">Effective Path Loss (dB)</option>
          <option value="sinr">Serving-cell SINR (dB)</option>
          <option value="best_sinr">Best available SINR (dB)</option>
          <option value="interference">Interference Power (dBm)</option>
          <option value="sir">SIR (dB)</option>
          <option value="inr">INR (dB)</option>
          <option value="dominance">Dominance Margin (dB)</option>
        </select>
      </div>

      <div className="flex flex-col gap-1 rounded border border-[#e3e0d6] bg-[#f5f3ec] p-2.5">
        <label className="text-[11px] font-bold text-slate-700">Coverage threshold ({coverageMetric === 'power' || coverageMetric === 'interference' ? 'dBm' : 'dB'}) · {['path_loss', 'interference', 'inr'].includes(coverageMetric) ? 'lower is better (≤)' : 'higher is better (≥)'}</label>
        <NumberField
          id="input-coverage-threshold"
          value={coverageThresholdDb}
          onChange={setCoverageThresholdDb}
          min={-250}
          max={100}
          step={1}
          className="text-[13px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900"
        />
        <p className="text-[10px] text-slate-500">Coverage probability and covered area use this threshold over the full map grid, including cells without a valid path.</p>
      </div>

      {/* Noise model — affects SINR and INR */}
      {(coverageMetric === 'sinr' || coverageMetric === 'best_sinr' || coverageMetric === 'inr') && (
        <div className="grid grid-cols-2 gap-3.5">
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-slate-600 font-bold">Bandwidth: {coverageBandwidthMhz} MHz</label>
            <input
              type="range" min="1" max="400" step="1"
              className="accent-[#cc785c] cursor-ew-resize"
              value={coverageBandwidthMhz}
              onChange={(e) => setCoverageBandwidthMhz(parseInt(e.target.value, 10))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-slate-600 font-bold">Noise Figure: {coverageNoiseFigureDb} dB</label>
            <input
              type="range" min="0" max="15" step="0.5"
              className="accent-[#cc785c] cursor-ew-resize"
              value={coverageNoiseFigureDb}
              onChange={(e) => setCoverageNoiseFigureDb(parseFloat(e.target.value))}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3.5 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-2.5">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-600 font-bold">Monte Carlo rays / Tx</label>
          <select
            id="select-radiomap-samples"
            className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
            value={samplesPerTx}
            onChange={(event) => setSamplesPerTx(parseInt(event.target.value, 10))}
          >
            <option value={100_000}>100k · preview</option>
            <option value={500_000}>500k</option>
            <option value={1_000_000}>1M · default</option>
            <option value={2_000_000}>2M · high quality</option>
            <option value={5_000_000}>5M · high quality</option>
            <option value={10_000_000}>10M · publication</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-600 font-bold">Deterministic seed</label>
          <NumberField
            id="input-radiomap-seed"
            integer
            min={0}
            max={2_147_483_647}
            step={1}
            value={radioMapSeed}
            onChange={setRadioMapSeed}
            className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c]"
          />
        </div>
        <p className="col-span-2 text-[11px] text-slate-500 leading-snug">
          Increase rays to reduce estimator variance. Reuse the seed for exact comparisons; change it to test convergence.
        </p>
      </div>

      <button
        id="btn-compute-radio-map"
        onClick={() => onRunHeatmap(coverageRes, coverageHeight, samplesPerTx, radioMapSeed)}
        disabled={heatmapLoading || !backendOnline || (bandOptions.length > 1 && selectedBand === '__all__')}
        className="w-full btn-signal text-[14px] font-bold py-2.5 px-3 rounded uppercase tracking-widest flex items-center justify-center gap-1.5 transition shadow-sm cursor-pointer border-none"
      >
        <Activity className={`w-4 h-4 text-white ${heatmapLoading ? 'animate-spin' : ''}`} />
        {heatmapLoading ? 'Computing Propagation Matrix...' : !backendOnline ? 'Backend offline' : (bandOptions.length > 1 && selectedBand === '__all__') ? 'Select one frequency band' : 'Map Coverage Matrix Grid'}
      </button>
      {solveError && (
        <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2.5 py-1.5 font-mono">
          {solveError}
        </div>
      )}

      {/* Overlay the ray-tracing links on top of the coverage map */}
      <button
        id="btn-toggle-rays-on-coverage"
        onClick={() => setShowRaysOnHeatmap(!showRaysOnHeatmap)}
        className="flex items-center justify-between gap-2 w-full bg-[#f5f3ec] border border-[#e3e0d6] rounded px-3 py-2 cursor-pointer hover:border-[#cc785c]/50 transition"
      >
        <span className="text-[12px] font-bold text-slate-700 flex items-center gap-1.5">
          <Navigation className="w-3.5 h-3.5 text-[#cc785c]" />
          Show Ray-Tracing Links
        </span>
        <span className={`relative w-9 h-4 rounded-full transition-colors ${showRaysOnHeatmap ? 'bg-[#cc785c]' : 'bg-slate-200'}`}>
          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${showRaysOnHeatmap ? 'left-5' : 'left-0.5'}`} />
        </span>
      </button>
      {showRaysOnHeatmap && (
        <p className="text-[11px] text-slate-600 -mt-1 leading-relaxed">
          Overlays the multipath rays from the last <strong className="text-[#cc785c]">Solve Link</strong> / <strong className="text-[#cc785c]">Solve All Pairs</strong>. Run a solve first if no rays appear.
        </p>
      )}

      {/* Display controls — colormap + range, like sionna-rt-gui's map panel */}
      <div className="flex flex-col gap-2.5 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-bold text-slate-700">Display</span>
          <label className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              id="chk-rm-autorange"
              className="accent-[#cc785c] cursor-pointer"
              checked={rmAutoRange}
              onChange={(e) => setRmAutoRange(e.target.checked)}
            />
            Auto range
          </label>
        </div>

        <select
          id="select-rm-colormap"
          className="text-[14px] py-1.5 px-2 bg-[#ffffff] border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
          value={rmColormap}
          onChange={(e) => setRmColormap(e.target.value as ColormapName)}
        >
          {COLORMAP_NAMES.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>

        {!rmAutoRange && coverageMetric === 'power' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-slate-600 font-bold">vmin: {rmVmin} dBm</span>
              <input
                type="range"
                id="slider-rm-vmin"
                min="-200"
                max="0"
                step="1"
                className="accent-[#cc785c] cursor-ew-resize"
                value={rmVmin}
                onChange={(e) => setRmVmin(Math.min(parseInt(e.target.value, 10), rmVmax))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-slate-600 font-bold">vmax: {rmVmax} dBm</span>
              <input
                type="range"
                id="slider-rm-vmax"
                min="-200"
                max="0"
                step="1"
                className="accent-[#cc785c] cursor-ew-resize"
                value={rmVmax}
                onChange={(e) => setRmVmax(Math.max(parseInt(e.target.value, 10), rmVmin))}
              />
            </div>
          </div>
        )}

        {/* Colorbar legend, scaled to the effective range (metric-aware) */}
        {radioMap && (() => {
          const unit = radioMap.unit ?? 'dBm';
          const metric = radioMap.metric ?? 'power';
          const useManual = !rmAutoRange && metric === 'power';
          let vmin = rmVmin;
          let vmax = rmVmax;
          if (!useManual) {
            if (radioMap.stats) {
              vmin = radioMap.stats.minVal ?? -120;
              vmax = radioMap.stats.maxVal ?? -50;
            } else {
              const values = radioMap.cells.map((c) => c.metricValue ?? c.powerDbm).filter((p) => Number.isFinite(p));
              vmin = values.length ? Math.min(...values) : -120;
              vmax = values.length ? Math.max(...values) : -50;
            }
          }
          const vmid = (vmin + vmax) / 2;
          const label = metricLabels[metric] ?? 'Coverage metric';
          return (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-slate-600 uppercase tracking-widest">{label} · {rmColormap}</span>
              <div className="w-full h-3 rounded" style={{ backgroundImage: colormapCssGradient(rmColormap) }} />
              <div className="flex justify-between font-mono text-[11px] text-slate-600">
                <span>{vmin.toFixed(0)} {unit}</span>
                <span>{vmid.toFixed(0)} {unit}</span>
                <span>{vmax.toFixed(0)} {unit}</span>
              </div>
            </div>
          );
        })()}
      </div>

      {radioMap && (
        <div className="flex gap-2 rounded border border-sky-200 bg-sky-50 p-2 text-[10px] leading-relaxed text-sky-900">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          Path Gain, RSS and per-TX SINR come from Sionna RT. Serving-cell SINR follows the strongest-RSS sector; Best available SINR selects the TX with the highest per-TX SINR. Path Gain selects the strongest channel gain independently of TX power. Interference, SIR, INR and dominance margin are derived from native outputs. Path Gain includes the configured TX array/pattern; the radio-map receiver is Sionna's ideal dual-polarized isotropic receiver.
        </div>
      )}

      {/* Coverage statistics, empirical CDF and per-sector summaries. */}
      {coverageStats && (
        <div className="flex flex-col gap-3 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-bold text-slate-700">Coverage & radio KPIs</span>
            <span className="text-[10px] px-2 py-0.5 rounded font-bold border bg-white border-[#e3e0d6] text-slate-600">{metricLabels[coverageStats.metric] ?? coverageStats.metric}</span>
          </div>
          <span className="text-[10px] text-slate-500 font-mono">
            {(radioMap?.samplesPerTx ?? samplesPerTx).toLocaleString()} rays/Tx · seed {radioMap?.seed ?? radioMapSeed} · {coverageStats.count.toLocaleString()} cells
          </span>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-white border border-[#e3e0d6] rounded p-2">
              <span className="text-[10px] text-slate-500 font-bold">Coverage Probability</span>
              <div className="text-[22px] font-bold font-mono text-[#5f7f5a]">{coverageStats.servedPercent.toFixed(1)}%</div>
              <span className="text-[10px] text-slate-500">{coverageStats.thresholdComparison === 'at_or_below' ? '≤' : '≥'} {coverageStats.thresholdDb.toFixed(1)} {coverageStats.unit}</span>
            </div>
            <div className="bg-white border border-[#e3e0d6] rounded p-2">
              <span className="text-[10px] text-slate-500 font-bold">Covered Area</span>
              <div className="text-[22px] font-bold font-mono text-slate-800">{coverageStats.servedAreaKm2.toFixed(3)}</div>
              <span className="text-[10px] text-slate-500">of {coverageStats.totalAreaKm2.toFixed(3)} km²</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {([['P5', coverageStats.p5], ['P50', coverageStats.p50], ['P95', coverageStats.p95]] as const).map(([lab, val]) => (
              <div key={lab} className="flex flex-col gap-0.5 bg-white border border-[#e3e0d6] rounded py-1.5">
                <span className="text-[10px] text-slate-500 font-bold">{lab}</span>
                <span className="font-mono text-[13px] font-bold text-slate-800">{val == null ? '—' : val.toFixed(1)}</span>
                <span className="text-[10px] text-slate-400">{coverageStats.unit}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-slate-600">
            <span>Reachable cells: <b>{coverageStats.reachablePercent.toFixed(1)}%</b></span>
            <span>Outage: <b>{coverageStats.outagePercent.toFixed(1)}%</b></span>
            <span>Mean RSS: <b>{coverageStats.meanRssDbm == null ? '—' : `${coverageStats.meanRssDbm.toFixed(1)} dBm`}</b></span>
            <span>Mean Path Gain: <b>{coverageStats.meanPathGainDb == null ? '—' : `${coverageStats.meanPathGainDb.toFixed(1)} dB`}</b></span>
            <span>Mean serving-cell SINR: <b>{coverageStats.meanSinrDb == null ? '—' : `${coverageStats.meanSinrDb.toFixed(1)} dB`}</b></span>
            <span>Mean best-TX SINR: <b>{coverageStats.meanBestSinrDb == null ? '—' : `${coverageStats.meanBestSinrDb.toFixed(1)} dB`}</b></span>
            <span>Mean interference: <b>{coverageStats.meanInterferenceDbm == null ? '—' : `${coverageStats.meanInterferenceDbm.toFixed(1)} dBm`}</b></span>
            <span>Noise floor: <b>{radioMap?.noisePowerDbm == null ? '—' : `${radioMap.noisePowerDbm.toFixed(1)} dBm`}</b></span>
            <span>Overlap (≥2 sectors): <b>{coverageStats.overlapPercent?.toFixed(1) ?? '—'}%</b></span>
            <span>Mean competing sectors: <b>{coverageStats.meanCompetingSectors?.toFixed(2) ?? '—'}</b></span>
          </div>
          {coverageStats.histogram && coverageStats.histogram.length > 0 && (
            <div className="bg-white border border-[#e3e0d6] rounded p-2">
              <div className="text-[10px] font-bold text-slate-600 mb-1">Metric histogram · {coverageStats.unit}</div>
              <svg viewBox="0 0 260 82" className="w-full h-20" role="img" aria-label="Coverage metric histogram">
                <line x1="8" y1="8" x2="8" y2="68" stroke="#cbd5e1" strokeWidth="1" />
                <line x1="8" y1="68" x2="252" y2="68" stroke="#cbd5e1" strokeWidth="1" />
                {(() => {
                  const maxCount = Math.max(...coverageStats.histogram!.map((bin) => bin.count), 1);
                  const width = 244 / coverageStats.histogram!.length;
                  return coverageStats.histogram!.map((bin, index) => {
                    const barHeight = (bin.count / maxCount) * 56;
                    return <rect key={index} x={8 + index * width + 0.5} y={68 - barHeight} width={Math.max(1, width - 1)} height={barHeight} fill="#5f7f5a" opacity="0.82"><title>{`${bin.binStart.toFixed(1)} to ${bin.binEnd.toFixed(1)} ${coverageStats.unit}: ${bin.count} cells (${bin.percent.toFixed(1)}%)`}</title></rect>;
                  });
                })()}
              </svg>
              <div className="flex justify-between text-[9px] text-slate-500"><span>{coverageStats.minVal?.toFixed(1) ?? '—'} {coverageStats.unit}</span><span>{coverageStats.maxVal?.toFixed(1) ?? '—'} {coverageStats.unit}</span></div>
            </div>
          )}
          {coverageStats.cdf && coverageStats.cdf.length > 1 && (
            <div className="bg-white border border-[#e3e0d6] rounded p-2">
              <div className="text-[10px] font-bold text-slate-600 mb-1">Empirical CDF · {coverageStats.unit}</div>
              <svg viewBox="0 0 260 88" className="w-full h-20" role="img" aria-label="Coverage metric empirical CDF">
                <line x1="8" y1="8" x2="8" y2="76" stroke="#cbd5e1" strokeWidth="1" />
                <line x1="8" y1="76" x2="252" y2="76" stroke="#cbd5e1" strokeWidth="1" />
                <polyline
                  fill="none"
                  stroke="#cc785c"
                  strokeWidth="2.5"
                  points={coverageStats.cdf.map((point) => {
                    const min = coverageStats.minVal ?? point.value;
                    const max = coverageStats.maxVal ?? point.value;
                    const span = Math.max(max - min, 1e-9);
                    const x = 8 + ((point.value - min) / span) * 244;
                    const y = 76 - ((point.percentile / 100) * 68);
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  }).join(' ')}
                />
                <text x="8" y="86" fontSize="8" fill="#64748b">0%</text>
                <text x="232" y="86" fontSize="8" fill="#64748b">100%</text>
              </svg>
            </div>
          )}
        </div>
      )}

      {radioMap?.txStats && radioMap.txStats.length > 0 && (
        <div className="flex flex-col gap-2 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold text-slate-700">Per-sector statistics</span>
            <span className="text-[10px] text-slate-500">{radioMap.txStats.length} TX</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] border-collapse">
              <thead><tr className="text-left text-slate-500 border-b border-[#d8d4c8]">
                <th className="py-1 pr-2">Sector / Site</th><th className="py-1 pr-2">Mean RSS</th><th className="py-1 pr-2">Mean SINR</th><th className="py-1 pr-2">Mean SNR</th><th className="py-1 pr-2">Mean I</th><th className="py-1 pr-2">Mean SIR</th><th className="py-1 pr-2">Mean INR</th><th className="py-1 pr-2">RSS assoc.</th><th className="py-1 pr-2">SINR assoc.</th><th className="py-1 pr-2">PG assoc.</th><th className="py-1">RSS Cov.</th><th className="py-1">SINR Cov.</th><th className="py-1">Top-I footprint</th><th className="py-1">Δ SINR Cov. w/o TX</th><th className="py-1">Export</th>
              </tr></thead>
              <tbody>
                {radioMap.txStats.map((tx) => (
                  <tr key={`${tx.txId}-${tx.txIndex}`} className="border-b border-[#e3e0d6]">
                    <td className="py-1.5 pr-2 min-w-[105px]">
                      <button type="button" onClick={() => { setSelectedSector(tx.txIndex); setSectorReport(null); }} className={`text-left rounded px-1 py-0.5 -ml-1 ${selectedSector === tx.txIndex ? 'bg-[#e8e2d5] ring-1 ring-[#c8b99f]' : 'hover:bg-white'}`}>
                        <div className="font-semibold text-slate-800">{tx.txName}</div><div className="text-slate-500">{tx.site ?? '—'} · {tx.frequencyBand ?? 'unclassified'}</div>
                      </button>
                    </td>
                    <td className="py-1.5 pr-2 font-mono">{tx.meanRssDbm == null ? '—' : tx.meanRssDbm.toFixed(1)}</td>
                    <td className="py-1.5 pr-2 font-mono">{tx.meanSinrDb == null ? '—' : tx.meanSinrDb.toFixed(1)}</td>
                    <td className="py-1.5 pr-2 font-mono">{tx.meanSnrDb == null ? '—' : tx.meanSnrDb.toFixed(1)}</td>
                    <td className="py-1.5 pr-2 font-mono">{tx.meanInterferenceDbm == null ? '—' : tx.meanInterferenceDbm.toFixed(1)}</td>
                    <td className="py-1.5 pr-2 font-mono">{tx.meanSirDb == null ? '—' : tx.meanSirDb.toFixed(1)}</td>
                    <td className="py-1.5 pr-2 font-mono">{tx.meanInrDb == null ? '—' : tx.meanInrDb.toFixed(1)}</td>
                    <td className="py-1.5 pr-2 font-mono">{tx.servingPercent.toFixed(1)}%</td>
                    <td className="py-1.5 pr-2 font-mono">{tx.sinrAssociationPercent?.toFixed(1) ?? '—'}%</td>
                    <td className="py-1.5 pr-2 font-mono">{tx.pathGainAssociationPercent?.toFixed(1) ?? '—'}%</td>
                    <td className="py-1.5 font-mono">{tx.rssCoveragePercent.toFixed(1)}%</td>
                    <td className="py-1.5 font-mono">{tx.sinrCoveragePercent.toFixed(1)}%</td>
                    <td className="py-1.5 font-mono">{tx.topInterfererCellPercent?.toFixed(1) ?? '0.0'}%</td>
                    <td className="py-1.5 font-mono" title="Coverage change if this sector were removed, calculated from cached RSS using static full-buffer interference assumptions">{tx.leaveOneOut ? `${tx.leaveOneOut.sinrCoverageDeltaPp > 0 ? '+' : ''}${tx.leaveOneOut.sinrCoverageDeltaPp.toFixed(1)} pp` : '—'}</td>
                    <td className="py-1"><button disabled={!radioMap.mapId || exportingTx === tx.txIndex} onClick={() => exportTx(tx.txIndex)} className="inline-flex items-center gap-1 rounded border border-[#d8d4c8] bg-white px-1.5 py-1 text-[10px] hover:border-[#cc785c] disabled:opacity-40" title="Download full per-cell Sionna metrics CSV"><Download className="w-3 h-3" />{exportingTx === tx.txIndex ? '…' : 'CSV'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {radioMap.siteStats && radioMap.siteStats.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              <span className="text-[11px] font-bold text-slate-700">Per-site statistics · strongest sector envelope</span>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px] border-collapse">
                  <thead><tr className="text-left text-slate-500 border-b border-[#d8d4c8]">
                    <th className="py-1 pr-2">Site</th><th className="py-1 pr-2">Sectors</th><th className="py-1 pr-2">Mean RSS</th><th className="py-1 pr-2">Mean SINR</th><th className="py-1 pr-2">Serving share</th><th className="py-1">RSS coverage</th>
                  </tr></thead>
                  <tbody>{radioMap.siteStats.map((site) => (
                    <tr key={site.site} className="border-b border-[#e3e0d6]">
                      <td className="py-1.5 pr-2 font-semibold text-slate-800">{site.site}</td>
                      <td className="py-1.5 pr-2 font-mono">{site.sectorCount}</td>
                      <td className="py-1.5 pr-2 font-mono">{site.meanRssDbm == null ? '—' : site.meanRssDbm.toFixed(1)}</td>
                      <td className="py-1.5 pr-2 font-mono">{site.meanSinrDb == null ? '—' : site.meanSinrDb.toFixed(1)}</td>
                      <td className="py-1.5 pr-2 font-mono">{site.servingPercent.toFixed(1)}%</td>
                      <td className="py-1.5 font-mono">{site.rssCoveragePercent.toFixed(1)}%</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <p className="text-[9px] text-slate-500">Site RSS coverage is the union of its sectors (strongest-sector envelope), not the sum of sector powers.</p>
            </div>
          )}
          {!radioMap.mapId && <p className="text-[10px] text-amber-700">Per-sector grid cache exceeded its memory budget; this run includes per-sector summary statistics but not per-sector CSV exports.</p>}
        </div>
      )}

      {radioMap && (
        <div className="flex flex-col gap-3 rounded border border-[#e3e0d6] bg-[#f5f3ec] p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[12px] font-bold text-slate-700">Cell-to-Sector Association</div>
              <div className="text-[10px] text-slate-500">Three independent assignments from native per-TX RSS, SINR and path-gain layers.</div>
            </div>
            <span className="rounded border border-[#e3e0d6] bg-white px-2 py-1 text-[10px] font-mono text-slate-500">{radioMap.cells.length.toLocaleString()} cells</span>
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={exportGeolocatedRadioMap} className="inline-flex items-center gap-1.5 rounded border border-[#cfc8b9] bg-white px-3 py-1.5 text-[10px] font-bold text-slate-700 hover:border-[#cc785c]"><Download className="h-3 w-3" /> Export full geolocated map CSV</button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-[9px] font-semibold text-slate-600">
              Association layer
              <select value={associationLayer} onChange={(event) => setAssociationLayer(event.target.value as AssociationLayer)} className="rounded border border-[#d8d4c8] bg-white px-2 py-1.5 text-[10px] font-normal text-slate-800">
                <option value="rss">RSS serving sector</option>
                <option value="sinr">Best SINR sector</option>
                <option value="path_gain">Best path-gain sector</option>
                <option value="interferer">Dominant interferer</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[9px] font-semibold text-slate-600">
              Candidate footprint
              <select value={candidateScope} onChange={(event) => setCandidateScope(event.target.value as typeof candidateScope)} className="rounded border border-[#d8d4c8] bg-white px-2 py-1.5 text-[10px] font-normal text-slate-800">
                <option value="all">All map cells</option>
                <option value="rss_serving">Only cells served by selected sector (RSS)</option>
                <option value="sinr_serving">Only cells assigned by best SINR</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[9px] font-semibold text-slate-600">
              Candidate ranking
              <select value={selectionMode} onChange={(event) => setSelectionMode(event.target.value as typeof selectionMode)} className="rounded border border-[#d8d4c8] bg-white px-2 py-1.5 text-[10px] font-normal text-slate-800">
                <option value="strict_topk">Strict Top-K (true weakest K)</option>
                <option value="spatially_distributed">Spatially distributed sample</option>
              </select>
            </label>
          </div>
          <CellAssociationMap
            radioMap={radioMap}
            txs={txs}
            layer={associationLayer}
            selectedCellIndex={focusedRadioMapCellIndex}
            onSelectCell={onFocusCell}
          />
          {focusedCell && focusedCellGeo && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 p-2">
              <div className="min-w-0">
                <div className="text-[10px] font-bold text-amber-900">Selected map cell #{focusedRadioMapCellIndex}</div>
                <div className="font-mono text-[9px] text-amber-900">{focusedCellGeo.lat.toFixed(7)}, {focusedCellGeo.lon.toFixed(7)}</div>
                <div className="font-mono text-[8px] text-amber-800">ENU {focusedCell.x.toFixed(2)}, {focusedCell.y.toFixed(2)}, {focusedCell.z.toFixed(2)} m</div>
              </div>
              <div className="flex gap-1">
                <button type="button" onClick={openFocusedCellInMaps} className="rounded border border-amber-300 bg-white px-2 py-1.5 text-[9px] font-semibold text-amber-900">Open Google Maps</button>
                <button type="button" onClick={() => void copyFocusedCellCoordinates()} className="rounded border border-amber-300 bg-white px-2 py-1.5 text-[9px] font-semibold text-amber-900">Copy coordinates</button>
              </div>
            </div>
          )}
          {radioMap.geoReference && (
            <div className="rounded border border-sky-200 bg-sky-50 p-2 text-[9px] leading-relaxed text-sky-900">
              <b>Georeference captured for this radio map:</b> WGS84 anchor {radioMap.geoReference.anchor.latitude.toFixed(7)}, {radioMap.geoReference.anchor.longitude.toFixed(7)} · {radioMap.geoReference.method}. Coordinates remain tied to this snapshot even if the map anchor is later moved.
            </div>
          )}
          {!radioMap.geoReference && (
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[9px] text-amber-900">This radio-map has no saved georeference snapshot. Coordinates will use the current scene anchor; verify it before using Google Maps.</div>
          )}
          {radioMap.associationStats && (
            <div className="grid grid-cols-3 gap-2">
              {([['RSS server', radioMap.associationStats.rss ?? []], ['Best SINR', radioMap.associationStats.sinr ?? []], ['Best path gain', radioMap.associationStats.pathGain ?? []]] as const).map(([label, entries]) => (
                <div key={label} className="rounded border border-[#e3e0d6] bg-white p-2">
                  <div className="text-[10px] font-bold text-slate-500">{label}</div>
                  <div className="mt-1 flex flex-col gap-1">
                    {entries.slice().sort((a, b) => b.cells - a.cells).slice(0, 4).map((entry) => (
                      <div key={entry.txIndex} className="flex items-center justify-between gap-1 text-[9px] text-slate-600">
                        <span className="truncate">{entry.txName}</span><b className="font-mono">{entry.percentOfAllCells.toFixed(1)}%</b>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="text-[10px] text-slate-600">
            Unassociated cells: RSS <b>{radioMap.associationStats?.unassociatedRssCells ?? '—'}</b> · SINR <b>{radioMap.associationStats?.unassociatedSinrCells ?? '—'}</b> · path gain <b>{radioMap.associationStats?.unassociatedPathGainCells ?? '—'}</b>.
          </div>
          <p className="text-[9px] text-slate-500">The 2D canvas and 3D categorical view use the same TX-index colour palette. TX crosses show transmitter positions; grey means no association in the selected layer. Click any cell to focus and mark it in the 3D scene.</p>
        </div>
      )}

      {radioMap?.txStats && radioMap.txStats.length > 0 && (
        <div className="flex flex-col gap-3 rounded border border-[#e3e0d6] bg-[#f5f3ec] p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[12px] font-bold text-slate-700">Sector Inspector</div>
              <div className="text-[10px] text-slate-500">Detailed per-sector distributions and spatial profile, loaded from the backend cache on demand.</div>
            </div>
            <span className="text-[10px] text-slate-500">No new ray-tracing</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={selectedSector} onChange={(event) => { setSelectedSector(Number(event.target.value)); setSectorReport(null); setSectorError(''); }} className="min-w-0 flex-1 rounded border border-[#d8d4c8] bg-white px-2 py-1.5 text-[11px] text-slate-800">
              {radioMap.txStats.map((tx) => <option key={tx.txIndex} value={tx.txIndex}>{tx.txName} · {tx.site ?? 'no Site'}</option>)}
            </select>
            <button type="button" onClick={() => void loadSectorReport()} disabled={!radioMap.mapId || sectorLoading} className="rounded border border-[#cfc8b9] bg-white px-3 py-1.5 text-[11px] font-bold text-slate-700 disabled:opacity-40">{sectorLoading ? 'Analysing…' : 'Analyse sector'}</button>
          </div>
          {sectorError && <p className="rounded border border-red-200 bg-red-50 p-2 text-[10px] text-red-700">{sectorError}</p>}
          {!radioMap.mapId && <p className="text-[10px] text-amber-700">Detailed analysis is unavailable because this radio-map's per-TX cache exceeded the configured memory budget.</p>}
          {sectorReport && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([['RSS mean', sectorReport.summaries.rss?.mean, 'dBm'], ['Network SINR', sectorReport.summaries.sinr?.mean, 'dB'], ['Isolated SNR', sectorReport.summaries.snr?.mean, 'dB'], ['Path gain', sectorReport.summaries.pathGain?.mean, 'dB'], ['Interference', sectorReport.summaries.interference?.mean, 'dBm'], ['SIR', sectorReport.summaries.sir?.mean, 'dB'], ['INR', sectorReport.summaries.inr?.mean, 'dB'] ] as const).map(([label, value, unit]) => (
                  <div key={label} className="rounded border border-[#e3e0d6] bg-white p-2">
                    <div className="text-[9px] font-bold text-slate-500">{label}</div>
                    <div className="font-mono text-[16px] font-bold text-slate-800">{value == null ? '—' : value.toFixed(1)} <span className="text-[9px] font-normal text-slate-400">{unit}</span></div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                {([['RSS association', sectorReport.associationSharePercent.rss], ['SINR association', sectorReport.associationSharePercent.sinr], ['Path-gain association', sectorReport.associationSharePercent.pathGain]] as const).map(([label, percent]) => (
                  <div key={label} className="rounded border border-[#e3e0d6] bg-white p-2"><div className="text-[9px] text-slate-500">{label}</div><div className="font-mono text-[14px] font-bold text-slate-800">{percent.toFixed(1)}%</div></div>
                ))}
              </div>
              <div className="rounded border border-[#e3e0d6] bg-white p-2">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[10px] font-bold text-slate-600">Sector distribution · CDF + histogram</div>
                  <select value={sectorDistributionMetric} onChange={(event) => setSectorDistributionMetric(event.target.value)} className="rounded border border-[#d8d4c8] bg-white px-2 py-1 text-[10px] text-slate-700">
                    {Object.entries(sectorDistributionLabels).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
                  </select>
                </div>
                {sectorDistribution?.cdf?.length ? (
                  <>
                    <svg viewBox="0 0 260 88" className="h-20 w-full" role="img" aria-label={`${sectorDistributionLabels[sectorDistributionMetric]?.label ?? 'Sector'} cumulative distribution`}>
                      <line x1="8" y1="8" x2="8" y2="76" stroke="#cbd5e1" />
                      <line x1="8" y1="76" x2="252" y2="76" stroke="#cbd5e1" />
                      <polyline fill="none" stroke="#4a727e" strokeWidth="2.5" points={sectorDistribution.cdf.map((point) => {
                        const min = sectorDistribution.minVal ?? point.value;
                        const max = sectorDistribution.maxVal ?? point.value;
                        const x = 8 + ((point.value - min) / Math.max(max - min, 1e-9)) * 244;
                        const y = 76 - point.percentile * 0.68;
                        return `${x.toFixed(1)},${y.toFixed(1)}`;
                      }).join(' ')} />
                    </svg>
                    {sectorDistribution.histogram?.length ? (
                      <svg viewBox="0 0 260 72" className="h-16 w-full" role="img" aria-label={`${sectorDistributionLabels[sectorDistributionMetric]?.label ?? 'Sector'} histogram`}>
                        <line x1="8" y1="62" x2="252" y2="62" stroke="#cbd5e1" />
                        {(() => {
                          const maxCount = Math.max(...sectorDistribution.histogram!.map((bin) => bin.count), 1);
                          const width = 244 / sectorDistribution.histogram!.length;
                          return sectorDistribution.histogram!.map((bin, index) => {
                            const height = (bin.count / maxCount) * 52;
                            return <rect key={index} x={8 + index * width + 0.5} y={62 - height} width={Math.max(1, width - 1)} height={height} fill="#79918c" opacity="0.85"><title>{`${bin.binStart.toFixed(1)} to ${bin.binEnd.toFixed(1)} ${sectorDistributionLabels[sectorDistributionMetric]?.unit ?? ''}: ${bin.count} cells`}</title></rect>;
                          });
                        })()}
                      </svg>
                    ) : null}
                    <div className="grid grid-cols-5 gap-1 text-center text-[9px] text-slate-500">
                      {([['P5', sectorDistribution.p5], ['P50', sectorDistribution.p50], ['P95', sectorDistribution.p95], ['σ', sectorDistribution.std], ['Mean', sectorDistribution.mean]] as const).map(([label, value]) => <div key={label}>{label}: <b className="font-mono text-slate-700">{value == null ? '—' : value.toFixed(1)}</b></div>)}
                    </div>
                    <div className="mt-1 text-right text-[9px] text-slate-400">{sectorDistributionLabels[sectorDistributionMetric]?.unit ?? sectorDistribution.unit}</div>
                  </>
                ) : <div className="text-[10px] text-slate-500">No finite values for this distribution.</div>}
              </div>
              {sectorReport.radialProfile.length > 0 && (
                <div className="overflow-x-auto rounded border border-[#e3e0d6] bg-white p-2">
                  <div className="mb-1 text-[10px] font-bold text-slate-600">Distance profile from sector position</div>
                  <table className="w-full text-[9px]"><thead><tr className="border-b text-left text-slate-500"><th className="py-1">Distance</th><th>Cells</th><th>Mean RSS</th><th>Mean SINR</th></tr></thead><tbody>{sectorReport.radialProfile.map((bin, i) => <tr key={i} className="border-b border-slate-100"><td className="py-1 font-mono">{bin.distanceStartM.toFixed(0)}–{bin.distanceEndM.toFixed(0)} m</td><td>{bin.cellCount}</td><td className="font-mono">{bin.meanRssDbm == null ? '—' : bin.meanRssDbm.toFixed(1)}</td><td className="font-mono">{bin.meanSinrDb == null ? '—' : bin.meanSinrDb.toFixed(1)}</td></tr>)}</tbody></table>
                </div>
              )}
              <p className="text-[9px] text-slate-500">Network SINR includes all other transmitters in the selected co-channel map. Isolated SNR is a derived RSS/noise ratio with all other TX contributions excluded; it is not SINR.</p>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => void exportSectorSamples('weak_sinr')} disabled={!!sampleExporting} className="rounded border border-[#d8d4c8] bg-white px-2 py-1.5 text-[10px] font-semibold text-slate-700 disabled:opacity-40">{sampleExporting === 'weak_sinr' ? 'Preparing…' : 'Export weakest SINR cells'}</button>
                <button onClick={() => void exportSectorSamples('weak_rss')} disabled={!!sampleExporting} className="rounded border border-[#d8d4c8] bg-white px-2 py-1.5 text-[10px] font-semibold text-slate-700 disabled:opacity-40">{sampleExporting === 'weak_rss' ? 'Preparing…' : 'Export weakest RSS cells'}</button>
                <button onClick={() => void exportSectorSamples('strong_interference')} disabled={!!sampleExporting} className="rounded border border-[#d8d4c8] bg-white px-2 py-1.5 text-[10px] font-semibold text-slate-700 disabled:opacity-40">{sampleExporting === 'strong_interference' ? 'Preparing…' : 'Export high-interference cells'}</button>
              </div>
            </>
          )}
        </div>
      )}

      {radioMap?.txStats && radioMap.txStats.length > 1 && (
        <div className="flex flex-col gap-3 rounded border border-[#e3e0d6] bg-[#f5f3ec] p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[12px] font-bold text-slate-700">Sector-to-Sector Interference</div>
              <div className="text-[10px] text-slate-500">Top-3 strongest non-serving sectors per victim sector, counted in its RSS-serving cells.</div>
            </div>
            <button type="button" onClick={() => void loadInterferenceMatrix()} disabled={!radioMap.mapId || matrixLoading} className="rounded border border-[#cfc8b9] bg-white px-3 py-1.5 text-[10px] font-bold text-slate-700 disabled:opacity-40">{matrixLoading ? 'Calculating…' : interferenceMatrix ? 'Refresh matrix' : 'Calculate matrix'}</button>
          </div>
          {matrixError && <p className="rounded border border-red-200 bg-red-50 p-2 text-[10px] text-red-700">{matrixError}</p>}
          {interferenceMatrix && (
            <>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded border border-[#e3e0d6] bg-white p-2"><div className="text-[9px] text-slate-500">Intra-site top-K hits</div><div className="font-mono text-[14px] font-bold">{interferenceMatrix.siteRelationCounts?.intra_site ?? 0}</div></div>
                <div className="rounded border border-[#e3e0d6] bg-white p-2"><div className="text-[9px] text-slate-500">Inter-site top-K hits</div><div className="font-mono text-[14px] font-bold">{interferenceMatrix.siteRelationCounts?.inter_site ?? 0}</div></div>
                <div className="rounded border border-[#e3e0d6] bg-white p-2"><div className="text-[9px] text-slate-500">Unknown Site metadata</div><div className="font-mono text-[14px] font-bold">{interferenceMatrix.siteRelationCounts?.unknown_site ?? 0}</div></div>
              </div>
              <div className="overflow-x-auto rounded border border-[#e3e0d6] bg-white">
                <table className="w-full text-[9px]"><thead><tr className="border-b text-left text-slate-500"><th className="p-2">Victim sector</th><th>Dominant interferer</th><th>Site relation</th><th>Cells</th><th>Share of victim area</th><th>Mean interferer</th><th>Mean Δ SINR if removed</th></tr></thead><tbody>
                  {interferenceMatrix.pairs.slice().sort((a, b) => b.cells - a.cells).map((pair, i) => <tr key={`${pair.victimTxIndex}-${pair.interfererTxIndex}-${i}`} className="border-b border-slate-100"><td className="p-2 font-semibold">{pair.victimTxName}<div className="text-[8px] font-normal text-slate-400">{pair.victimSite ?? 'unknown site'}</div></td><td>{pair.interfererTxName}<div className="text-[8px] text-slate-400">{pair.interfererSite ?? 'unknown site'}</div></td><td>{pair.siteRelation === 'intra_site' ? 'Intra-site' : pair.siteRelation === 'inter_site' ? 'Inter-site' : 'Unknown'}</td><td className="font-mono">{pair.cells}</td><td className="font-mono">{pair.shareOfVictimCellsPercent.toFixed(1)}%</td><td className="font-mono">{pair.meanDominantInterferenceDbm.toFixed(1)} dBm</td><td className="font-mono text-emerald-700">+{pair.meanSinrGainIfRemovedDb.toFixed(2)} dB</td></tr>)}
                </tbody></table>
              </div>
              <p className="text-[9px] text-slate-500">The matrix reports the ranked top-K interferers only. All weaker co-channel sectors remain included in native SINR and in the total interference denominator. Δ SINR is the per-cell improvement if that one dominant interferer were removed, holding all other powers fixed.</p>
            </>
          )}
        </div>
      )}

      {radioMap?.mapId && (
        <ChannelAnalysisPanel
          radioMap={radioMap}
          rx={rx}
          anchor={radioMap.geoReference?.anchor ?? anchor}
          candidateScope={candidateScope}
          selectionMode={selectionMode}
          onFocusCell={onFocusCell}
        />
      )}

    </div>
  );
}
