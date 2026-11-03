/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileSpreadsheet, Upload } from 'lucide-react';
import { GeoAnchor, Transmitter } from '../types';
import { latLonToENU } from '../utils';
import {
  ALL_BASE_STATION_BANDS,
  BaseStationDraft,
  baseStationDraftsToTransmitters,
  filterBaseStationDraftsByBand,
  parseBaseStationFile,
} from '../utils/baseStationImport';

interface Props {
  anchor: GeoAnchor;
  currentTxCount: number;
  onImport: (transmitters: Transmitter[], replaceExisting: boolean) => void;
  defaultArraySize: [number, number];
}

export function BaseStationImportPanel({ anchor, currentTxCount, onImport, defaultArraySize }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<BaseStationDraft[]>([]);
  const [selectedBand, setSelectedBand] = useState(ALL_BASE_STATION_BANDS);
  const [fileName, setFileName] = useState('');
  const [heightReference, setHeightReference] = useState<'agl' | 'roof' | 'scene_z' | ''>('');
  const [powerMeaning, setPowerMeaning] = useState<'conducted' | 'eirp' | ''>('');
  const [defaultGain, setDefaultGain] = useState('');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [success, setSuccess] = useState('');
  const selectedDrafts = filterBaseStationDraftsByBand(drafts, selectedBand);
  const bandCounts = drafts.reduce((map, row) => {
    map.set(row.frequencyBand, (map.get(row.frequencyBand) ?? 0) + 1);
    return map;
  }, new Map<string, number>());
  const bandOptions = Array.from(bandCounts.keys());
  const maxAnchorDistanceKm = selectedDrafts.length
    ? Math.max(...selectedDrafts.map((row) => {
        const enu = latLonToENU(row.latitude, row.longitude, anchor);
        return Math.hypot(enu.x, enu.y) / 1000;
      }))
    : 0;
  const anchorMismatch = maxAnchorDistanceKm > 100;

  const handleFile = async (file?: File) => {
    if (!file) return;
    setLoading(true);
    setError('');
    setSuccess('');
    setWarnings([]);
    try {
      const parsed = await parseBaseStationFile(file);
      setDrafts(parsed);
      const availableBands = Array.from(new Set(parsed.map((row) => row.frequencyBand)));
      // The user's current research focus is n78. Preselect it when present,
      // while keeping an explicit All antennas option available.
      const n78Label = availableBands.find((band) => band.trim().toLowerCase() === 'n78');
      setSelectedBand(n78Label ?? ALL_BASE_STATION_BANDS);
      setFileName(file.name);
    } catch (e: any) {
      setDrafts([]);
      setSelectedBand(ALL_BASE_STATION_BANDS);
      setFileName('');
      setError(e?.message ?? 'The file could not be read.');
    } finally {
      setLoading(false);
    }
  };

  const doImport = () => {
    setError('');
    setSuccess('');
    const gain = defaultGain.trim() ? Number(defaultGain) : undefined;
    if (!heightReference) {
      setError('Select how the Height (m) column is defined: AGL, above roof, or absolute local scene Z.');
      return;
    }
    if (!powerMeaning) {
      setError('Select whether the Power (dBm) column represents conducted power or EIRP.');
      return;
    }
    if (!selectedDrafts.length) {
      setError('The selected band contains no valid antennas to import.');
      return;
    }
    if (anchorMismatch) {
      setError(`The current map anchor is too far from the selected antennas (maximum distance: ${maxAnchorDistanceKm.toFixed(1)} km). Recenter the map anchor on the same area as the OSM scene and imported station inventory, then retry the import.`);
      return;
    }
    if (powerMeaning === 'eirp' && gain == null && selectedDrafts.some((row) => row.antennaGainDbi == null)) {
      setError('Power is marked as EIRP, but antenna gain [dBi] is missing. Add an antenna-gain column to the table or enter a common gain value.');
      return;
    }
    const result = baseStationDraftsToTransmitters(selectedDrafts, anchor, {
      heightReference,
      powerColumnMeaning: powerMeaning,
      defaultAntennaGainDbi: gain,
      defaultArraySize,
    });
    if (!result.transmitters.length) {
      setError('No base stations could be imported.');
      return;
    }
    onImport(result.transmitters, replaceExisting);
    setWarnings(result.warnings);
    const selectionLabel = selectedBand === ALL_BASE_STATION_BANDS ? 'all bands' : `band ${selectedBand}`;
    setSuccess(`Imported ${result.transmitters.length} antennas (${selectionLabel})${result.skippedRows.length ? `; skipped ${result.skippedRows.length} rows` : ''}.`);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[#e3e0d6] bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4 text-[#cc785c]" />
          <div className="text-[12px] font-bold text-slate-800">Import Base Stations</div>
        </div>
        <span className="rounded border border-[#e3e0d6] bg-[#f5f3ec] px-2 py-0.5 text-[10px] font-semibold text-slate-500">
          XLSX / CSV
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-slate-600">
        Import a spreadsheet containing coordinates, height, azimuth, downtilt, power, and frequency band. Coordinates are converted to ENU relative to the current map anchor.
      </p>
      <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-[10px] leading-relaxed text-emerald-900">
        <strong>Privacy:</strong> CSV/XLSX files are parsed locally in this browser. The original file contents are not sent to the backend or uploaded to Colab; only the extracted transmitter data is added to the application.
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".xlsx,.csv,.tsv,.txt"
        className="hidden"
        onChange={(event) => { void handleFile(event.target.files?.[0]); event.currentTarget.value = ''; }}
      />
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        disabled={loading}
        className="flex w-full items-center justify-center gap-2 rounded border border-dashed border-[#cc785c]/60 bg-[#fbf3ef] px-3 py-2 text-[12px] font-bold text-[#9b573f] hover:bg-[#f7e9e2] disabled:opacity-50"
      >
        <Upload className="h-3.5 w-3.5" />
        {loading ? 'Reading spreadsheet…' : fileName || 'Choose base-station spreadsheet'}
      </button>

      {drafts.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[10px] font-bold text-slate-600">
              Height reference
              <select value={heightReference} onChange={(e) => setHeightReference(e.target.value as typeof heightReference)} className="rounded border border-[#e3e0d6] bg-white px-2 py-1.5 text-[11px] text-slate-800">
                <option value="" disabled>Select height datum…</option>
                <option value="agl">Above local ground (AGL)</option>
                <option value="roof">Above building roof</option>
                <option value="scene_z">Absolute local scene Z</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-bold text-slate-600">
              Power column means
              <select value={powerMeaning} onChange={(e) => setPowerMeaning(e.target.value as typeof powerMeaning)} className="rounded border border-[#e3e0d6] bg-white px-2 py-1.5 text-[11px] text-slate-800">
                <option value="" disabled>Select power reference…</option>
                <option value="conducted">Conducted TX power</option>
                <option value="eirp">EIRP</option>
              </select>
            </label>
          </div>
          <div className="rounded border border-[#d8e5f1] bg-[#f2f7fb] p-2">
            <label className="mb-1 flex items-center justify-between gap-2 text-[11px] font-bold text-slate-700">
              <span>Band to place in the 3D scene</span>
              <span className="rounded bg-white px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">{selectedDrafts.length} / {drafts.length} antennas</span>
            </label>
            <select
              value={selectedBand}
              onChange={(event) => setSelectedBand(event.target.value)}
              className="w-full rounded border border-[#d8e5f1] bg-white px-2 py-1.5 text-[11px] text-slate-800"
            >
              <option value={ALL_BASE_STATION_BANDS}>All antennas — all bands ({drafts.length})</option>
              {bandOptions.map((band) => (
                <option key={band} value={band}>{band} ({bandCounts.get(band) ?? 0})</option>
              ))}
            </select>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
              Select one band to place only its antennas, or choose “All antennas” to use the complete inventory. If the table contains n78, it is preselected. Other rows remain available in the local spreadsheet preview and are not discarded.
            </p>
          </div>

          <div className="rounded bg-[#fff8eb] p-2 text-[10px] leading-relaxed text-[#795b2b]">
            Exact carrier frequency is never inferred from Frequency Band labels (including n78, GSM 900 or the 791/2110 MHz text in a band name). Add a separate Carrier/Center Frequency column when known; otherwise select one band group and explicitly set its deployed downlink channel in RF Controls before solving.
          </div>
          {powerMeaning === 'eirp' && (
            <label className="flex flex-col gap-1 text-[10px] font-bold text-slate-600">
              Common antenna gain [dBi] (only if no per-row gain column)
              <input type="number" step="0.1" value={defaultGain} onChange={(e) => setDefaultGain(e.target.value)} placeholder="e.g. 17" className="rounded border border-[#e3e0d6] px-2 py-1.5 text-[12px] font-normal text-slate-800" />
            </label>
          )}
          <label className="flex items-center gap-2 text-[11px] text-slate-700">
            <input type="checkbox" checked={replaceExisting} onChange={(e) => setReplaceExisting(e.target.checked)} className="accent-[#cc785c]" />
            Replace current transmitters ({currentTxCount}) instead of appending
          </label>

          <div className={`rounded border p-2 text-[10px] leading-relaxed ${anchorMismatch ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
            <strong>Geographic anchor check:</strong> the farthest site is {maxAnchorDistanceKm.toFixed(2)} km from the current scene anchor. {anchorMismatch ? 'This large distance suggests that the anchor may not be centered on the selected station/scene area. Change it by clicking the map before importing.' : 'The coordinates fit within the current map’s local ENU frame.'}
          </div>

          <div className="rounded border border-[#e3e0d6] bg-[#f8f7f2] p-2">
            <div className="mb-2 text-[11px] font-bold text-slate-700">Band inventory</div>
            <div className="mb-2 flex flex-wrap gap-1">
              {Array.from(drafts.reduce((map, row) => map.set(row.frequencyBand || 'Band not specified', (map.get(row.frequencyBand || 'Band not specified') ?? 0) + 1), new Map<string, number>())).map(([band, count]) => (
                <span key={band} className="rounded border border-[#e3e0d6] bg-white px-1.5 py-0.5 text-[9px] text-slate-600">{band}: {count}</span>
              ))}
            </div>
            <div className="mb-1 text-[11px] font-bold text-slate-700">Site inventory</div>
            <div className="mb-2 flex flex-wrap gap-1">
              {Array.from(drafts.reduce((map, row) => map.set(row.site || 'Site not specified', (map.get(row.site || 'Site not specified') ?? 0) + 1), new Map<string, number>())).map(([site, count]) => (
                <span key={site} className="rounded border border-[#e3e0d6] bg-white px-1.5 py-0.5 text-[9px] text-slate-600">{site}: {count}</span>
              ))}
            </div>
            <div className="mb-1 flex items-center justify-between text-[11px] font-bold text-slate-700">
              <span>Selected antenna preview</span>
              <span>{selectedDrafts.length} selected · {new Set(selectedDrafts.map((row) => row.site).filter(Boolean)).size} sites</span>
            </div>
            <div className="max-h-36 overflow-auto">
              <table className="w-full border-collapse text-left text-[10px]">
                <thead className="sticky top-0 bg-[#ebe7dc] text-slate-600">
                  <tr><th className="p-1">Site / sector</th><th className="p-1">Lat, Lon</th><th className="p-1">H / Az / Tilt</th><th className="p-1">Power / Band</th></tr>
                </thead>
                <tbody>
                  {selectedDrafts.slice(0, 12).map((row) => (
                    <tr key={row.rowNumber} className="border-t border-[#e3e0d6]">
                      <td className="p-1">{row.site || '—'}<br />{row.transmitter || row.antenna || `Row ${row.rowNumber}`}</td>
                      <td className="p-1 font-mono">{row.latitude.toFixed(5)}, {row.longitude.toFixed(5)}</td>
                      <td className="p-1 font-mono">{row.heightM} m / {row.azimuthDeg}° / {row.mechanicalDowntiltDeg}°</td>
                      <td className="p-1 font-mono">{row.powerDbm} dBm<br />{row.frequencyBand || 'band n/a'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {selectedDrafts.length > 12 && <div className="pt-1 text-center text-[10px] text-slate-500">Showing 12 of {selectedDrafts.length} selected rows.</div>}
            </div>
          </div>

          <div className="rounded bg-[#fff8eb] p-2 text-[10px] leading-relaxed text-[#795b2b]">
            <strong>RF integrity:</strong> Antenna/model and band strings are preserved as metadata; no vendor pattern or carrier frequency is guessed. The current Sionna scene uses the TX antenna pattern selected in RF Controls, not a per-row manufacturer pattern. Positive downtilt becomes negative beam elevation. EIRP is converted to conducted power only when antenna gain is available. AGL assumes local ground Z=0 because the current OSM scene has no terrain-elevation model.
          </div>
          <button type="button" onClick={doImport} disabled={anchorMismatch || selectedDrafts.length === 0} className="w-full rounded bg-[#cc785c] px-3 py-2 text-[12px] font-bold text-white hover:bg-[#b9684e] disabled:cursor-not-allowed disabled:opacity-40">
            Import {selectedDrafts.length} {selectedBand === ALL_BASE_STATION_BANDS ? 'antennas (all bands)' : `antennas (${selectedBand})`}
          </button>
        </>
      )}

      {error && <div className="flex items-start gap-1.5 rounded bg-red-50 p-2 text-[11px] leading-relaxed text-red-700"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}
      {success && <div className="flex items-start gap-1.5 rounded bg-green-50 p-2 text-[11px] text-green-800"><CheckCircle2 className="h-3.5 w-3.5 shrink-0" />{success}</div>}
      {warnings.map((warning, i) => <div key={i} className="rounded bg-amber-50 p-2 text-[10px] leading-relaxed text-amber-800">{warning}</div>)}
    </div>
  );
}
