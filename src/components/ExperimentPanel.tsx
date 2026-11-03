import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, Archive, ArrowDownToLine, Check, ChevronDown, CircleAlert, Clock3,
  Columns3, Database, FileText, Fingerprint, FlaskConical, Play, Plus, RefreshCw,
  RotateCcw, Save, Trash2, X, Square,
} from 'lucide-react';
import {
  ConfigurationPreset, createConfigurationPreset, deleteConfigurationPreset,
  deleteExperimentRecord, ExperimentRun, listConfigurationPresets, listExperimentRecords,
  cancelPhyBerJob, cancelMeasurementRayTraceJob,
} from '../api';

interface ExperimentPanelProps {
  backendOnline: boolean;
  currentConfiguration: Record<string, unknown>;
  onApplyConfiguration: (configuration: Record<string, unknown>) => void;
  onRetryExperiment: (experiment: ExperimentRun) => Promise<void>;
}

type View = 'history' | 'presets' | 'compare' | 'reports';
const pretty = (value: unknown) => {
  if (value == null) return '—';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};
const dateText = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '—';
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char] as string));
const formatBytes = (value: number) => `${(value / 1024).toFixed(1)} KB`;

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    running: 'bg-blue-100 text-blue-800', done: 'bg-emerald-100 text-emerald-800',
    error: 'bg-rose-100 text-rose-800', cancelled: 'bg-amber-100 text-amber-900',
  };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${styles[status] ?? 'bg-gray-100 text-gray-700'}`}>{status}</span>;
}

function flattenScalars(value: unknown, prefix = ''): Array<[string, string]> {
  if (!value || typeof value !== 'object') return value === undefined ? [] : [[prefix || 'value', pretty(value)]];
  if (Array.isArray(value)) return value.length <= 8 ? [[prefix, value.map(pretty).join(', ')]] : [[prefix, `[${value.length} items]`]];
  const out: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object') out.push(...flattenScalars(item, path));
    else out.push([path, pretty(item)]);
  }
  return out;
}

function makeValidationReport(run: ExperimentRun): string {
  const result = run.results as Record<string, any>;
  const rows = Array.isArray(result.validationRows) ? result.validationRows : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const profile = result.profile ?? {};
  const rf = result.rfConfiguration ?? {};
  const trs = rows.map((row: any) => `<tr>
    <td>${escapeHtml(row.sampleIndex)}</td><td>${escapeHtml(row.latitude)}</td><td>${escapeHtml(row.longitude)}</td>
    <td>${escapeHtml(row.measuredRsrpMedianDbm)}</td><td>${escapeHtml(row.simulatedTotalRxPowerDbm)}</td>
    <td>${escapeHtml(row.simulatedChannelGainDb)}</td><td>${escapeHtml(row.losStatus)}</td>
    <td>${escapeHtml(row.numPaths)}</td><td>${row.simulationValid ? 'Yes' : 'No'}</td>
  </tr>`).join('');
  const warningList = warnings.map((warning: string) => `<li>${escapeHtml(warning)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Validation report — ${escapeHtml(run.name)}</title><style>
body{font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#202b31;margin:32px;max-width:1200px}h1,h2{color:#24434a}h1{font-size:26px}h2{font-size:18px;margin-top:28px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.card{border:1px solid #d7e0e2;border-radius:8px;padding:12px}.label{color:#64777d;font-size:11px;text-transform:uppercase}.value{font-weight:650;font-size:18px;overflow-wrap:anywhere}.warning{background:#fff7e8;border-left:4px solid #c77b32;padding:12px;margin:16px 0}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d7e0e2;padding:6px;text-align:left}th{background:#edf2f3;position:sticky;top:0}.table-wrap{overflow-x:auto}.mono{font-family:ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}.muted{color:#63747a}@media print{body{margin:12mm}.table-wrap{overflow:visible}}
</style></head><body>
<h1>SionnaRTStudio — Field Measurement Validation Report</h1>
<p class="muted">Generated ${escapeHtml(new Date().toLocaleString())} · Experiment ${escapeHtml(run.id)}</p>
<div class="grid">
<div class="card"><div class="label">Dataset</div><div class="value">${escapeHtml(result.filename ?? result.datasetId ?? '—')}</div></div>
<div class="card"><div class="label">Radio profile</div><div class="value">${escapeHtml(`${profile.rat ?? '—'} · PCI ${profile.pci ?? '—'} · Band ${profile.band ?? '—'} · ARFCN ${profile.arfcn ?? '—'}`)}</div></div>
<div class="card"><div class="label">Selected transmitter</div><div class="value">${escapeHtml(result.transmitter?.txName ?? result.transmitter?.txId ?? '—')}</div></div>
<div class="card"><div class="label">Measured modem RSRP median</div><div class="value">${escapeHtml(result.medianMeasuredRsrpDbm)} dBm</div></div>
<div class="card"><div class="label">Simulated total received power median</div><div class="value">${escapeHtml(result.medianSimulatedTotalRxPowerDbm)} dBm</div></div>
<div class="card"><div class="label">PathSolver valid locations</div><div class="value">${escapeHtml(result.validSimulationCount ?? 0)} / ${escapeHtml(result.sampleCountReturned ?? rows.length)}</div></div>
</div>
<div class="warning"><strong>Scientific comparability warning.</strong> The simulated value is Sionna RT total received power across resolved paths, while the modem value is NR SS-RSRP. These are not yet equivalent physical quantities. Therefore this report deliberately does not calculate residuals, MAE, RMSE, bias, or claim calibrated RSRP validation. A reference-signal and receiver measurement model is required first.</div>
<h2>RF configuration and reproducibility</h2>
<p>Fingerprint: <span class="mono">${escapeHtml(result.rfConfigurationFingerprint ?? run.configurationFingerprint)}</span></p>
<p>Effective carrier: ${escapeHtml(result.frequencyGhz ?? rf.frequency?.effectiveGhz)} GHz · Max depth: ${escapeHtml(result.maxDepth ?? rf.pathSolver?.maxDepth)} · Path samples/source: ${escapeHtml(rf.pathSolver?.pathSamplesPerSource)} · Seed: ${escapeHtml(rf.pathSolver?.pathSeed)}</p>
<p>TX power: ${escapeHtml(rf.tx?.powerDbm)} dBm (${escapeHtml(rf.tx?.powerReference ?? 'reference unspecified')}) · TX array: ${escapeHtml(rf.tx?.arraySize?.join(' × '))} · RX height AGL: ${escapeHtml(result.rxHeightAglM ?? rf.rx?.heightAglM)} m</p>
<details><summary>Full RF configuration snapshot</summary><pre class="mono">${escapeHtml(JSON.stringify(rf, null, 2))}</pre></details>
<h2>Solver and measurement warnings</h2><ul>${warningList || '<li>No additional warnings recorded.</li>'}</ul>
<h2>Sample-level observations (${rows.length})</h2>
<div class="table-wrap"><table><thead><tr><th>#</th><th>Latitude</th><th>Longitude</th><th>Measured RSRP (dBm)</th><th>Simulated total Rx (dBm)</th><th>Channel gain (dB)</th><th>LOS</th><th>Paths</th><th>Valid</th></tr></thead><tbody>${trs}</tbody></table></div>
<p class="muted">Run started ${escapeHtml(dateText(run.startedAtUtc))}; completed ${escapeHtml(dateText(run.completedAtUtc))}; duration ${escapeHtml(run.durationMs == null ? '—' : `${(run.durationMs / 1000).toFixed(1)} s`)}.</p>
</body></html>`;
}

export function ExperimentPanel({ backendOnline, currentConfiguration, onApplyConfiguration, onRetryExperiment }: ExperimentPanelProps) {
  const [view, setView] = useState<View>('history');
  const [runs, setRuns] = useState<ExperimentRun[]>([]);
  const [presets, setPresets] = useState<ConfigurationPreset[]>([]);
  const [selectedRuns, setSelectedRuns] = useState<string[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');
  const [presetDescription, setPresetDescription] = useState('');
  const [filter, setFilter] = useState<'all' | 'done' | 'error' | 'cancelled' | 'running'>('all');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const refresh = async () => {
    if (!backendOnline) return;
    setBusy(true); setError('');
    try {
      const [history, savedPresets] = await Promise.all([listExperimentRecords(), listConfigurationPresets()]);
      setRuns(history); setPresets(savedPresets);
      setSelectedRuns((current) => current.filter((id) => history.some((run) => run.id === id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  useEffect(() => { void refresh(); }, [backendOnline]);
  useEffect(() => {
    const handleStoreChanged = () => { void refresh(); };
    window.addEventListener('sionna-experiments-changed', handleStoreChanged);
    return () => window.removeEventListener('sionna-experiments-changed', handleStoreChanged);
  }, [backendOnline]);
  // Automatically refresh active work so Run History follows long-running jobs
  // even when the user is on another workspace.
  useEffect(() => {
    if (!backendOnline || busy || !runs.some((run) => run.status === 'running')) return;
    const timer = window.setInterval(() => { void refresh(); }, 4000);
    return () => window.clearInterval(timer);
  }, [backendOnline, runs, busy]);

  const filteredRuns = useMemo(() => filter === 'all' ? runs : runs.filter((run) => run.status === filter), [runs, filter]);
  const selected = useMemo(() => selectedRuns.map((id) => runs.find((run) => run.id === id)).filter((run): run is ExperimentRun => Boolean(run)), [selectedRuns, runs]);
  const comparablePaths = useMemo(() => {
    const all = selected.flatMap((run) => [
      ...flattenScalars(run.configuration, 'configuration'),
      ...flattenScalars(run.parameters, 'parameters'),
      ...flattenScalars(run.results, 'results'),
    ]);
    const counts = new Map<string, number>();
    all.forEach(([path]) => counts.set(path, (counts.get(path) ?? 0) + 1));
    return Array.from(counts.entries()).filter(([, count]) => count >= 2).map(([path]) => path).slice(0, 40);
  }, [selected]);

  const savePreset = async () => {
    if (!presetName.trim()) { setError('Enter a name for the RF configuration preset.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const created = await createConfigurationPreset({ name: presetName.trim(), description: presetDescription.trim(), configuration: currentConfiguration });
      setPresets((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      setPresetName(''); setPresetDescription(''); setMessage(`Preset “${created.name}” was saved.`);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const removeRun = async (run: ExperimentRun) => {
    if (!window.confirm(`Delete experiment “${run.name}” from the history?`)) return;
    setBusyId(run.id); setError('');
    try {
      await deleteExperimentRecord(run.id);
      setRuns((current) => current.filter((item) => item.id !== run.id));
      setSelectedRuns((current) => current.filter((id) => id !== run.id));
      setMessage('Experiment was removed from the history.');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusyId(null); }
  };

  const removePreset = async (preset: ConfigurationPreset) => {
    setBusyId(preset.id); setError('');
    try {
      await deleteConfigurationPreset(preset.id);
      setPresets((current) => current.filter((item) => item.id !== preset.id));
      setMessage(`Preset “${preset.name}” was deleted.`);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusyId(null); }
  };

  const retryRun = async (run: ExperimentRun) => {
    setBusyId(run.id); setError(''); setMessage('');
    try {
      await onRetryExperiment(run);
      await refresh();
      setMessage(`Experiment “${run.name}” was rerun.`);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusyId(null); }
  };

  const cancelRun = async (run: ExperimentRun) => {
    const jobId = String((run.results as Record<string, unknown>).jobId ?? '');
    if (!jobId) { setError('This record has no active backend job ID.'); return; }
    setBusyId(run.id); setError(''); setMessage('');
    try {
      const status = run.kind === 'phy_sweep'
        ? await cancelPhyBerJob(jobId)
        : run.kind === 'measurement_raytrace'
          ? await cancelMeasurementRayTraceJob(jobId)
          : null;
      if (!status) throw new Error('Cancellation is not supported for this calculation type.');
      setMessage(status.message || 'Cancellation request submitted.');
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusyId(null); }
  };

  const downloadValidationReport = (run: ExperimentRun) => {
    const html = makeValidationReport(run);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `SionnaRTStudio_validation_${run.id.slice(0, 8)}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage('The HTML validation report was generated. Open it in a browser and print it to PDF.');
  };

  const toggleSelected = (id: string) => setSelectedRuns((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return (
    <section className="flex flex-col gap-5 w-full min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="eyebrow text-[var(--text-lo)]">Reproducibility workspace</div><h2 className="text-2xl font-semibold mt-1">Experiments</h2><p className="text-sm text-[var(--text-mid)] mt-1">Run history, reusable RF presets, experiment comparison, and validation reports.</p></div>
        <button type="button" onClick={() => void refresh()} disabled={!backendOnline || busy} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm flex items-center gap-2 disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`}/> Refresh</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border border-[var(--line)] p-3"><div className="eyebrow text-[var(--text-lo)]">Saved runs</div><div className="text-2xl font-mono font-semibold mt-1">{runs.length}</div></div>
        <div className="rounded-lg border border-[var(--line)] p-3"><div className="eyebrow text-[var(--text-lo)]">Successful</div><div className="text-2xl font-mono font-semibold mt-1">{runs.filter((run) => run.status === 'done').length}</div></div>
        <div className="rounded-lg border border-[var(--line)] p-3"><div className="eyebrow text-[var(--text-lo)]">Failed / cancelled</div><div className="text-2xl font-mono font-semibold mt-1">{runs.filter((run) => run.status === 'error' || run.status === 'cancelled').length}</div></div>
        <div className="rounded-lg border border-[var(--line)] p-3"><div className="eyebrow text-[var(--text-lo)]">RF presets</div><div className="text-2xl font-mono font-semibold mt-1">{presets.length}</div></div>
      </div>

      {!backendOnline && <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">Backend is unavailable. Experiment history and presets are stored in the backend SQLite database.</div>}
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 flex items-start gap-2"><CircleAlert className="w-4 h-4 shrink-0 mt-0.5"/>{error}</div>}
      {message && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 flex items-start gap-2"><Check className="w-4 h-4 shrink-0 mt-0.5"/>{message}</div>}

      <div className="flex flex-wrap gap-1 border-b border-[var(--line)]">
        {([['history', 'Run History', Clock3], ['presets', 'Configuration Presets', Save], ['compare', 'Experiment Comparison', Columns3], ['reports', 'Validation Report', FileText]] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" onClick={() => setView(id)} className={`px-3 py-2.5 text-sm border-b-2 -mb-px flex items-center gap-2 ${view === id ? 'border-[var(--accent)] text-[var(--text-hi)] font-semibold' : 'border-transparent text-[var(--text-mid)]'}`}><Icon className="w-4 h-4"/>{label}</button>
        ))}
      </div>

      {view === 'history' && <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm text-[var(--text-mid)]">Every successful or failed solver run records its timestamp, parameters, seed, and configuration SHA-256 fingerprint.</div><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} className="rounded-md border border-[var(--line)] bg-[var(--page)] px-2 py-2 text-sm"><option value="all">All statuses</option><option value="done">Done</option><option value="running">Running</option><option value="error">Error</option><option value="cancelled">Cancelled</option></select></div>
        {filteredRuns.length === 0 ? <div className="rounded-lg border border-dashed border-[var(--line)] p-8 text-center text-sm text-[var(--text-lo)]"><Database className="w-7 h-7 mx-auto mb-2 opacity-60"/>No experiments have been recorded yet. Run Link, Radio Map, Mobility, PHY, or Measurement Ray Trace.</div> : <div className="overflow-x-auto rounded-lg border border-[var(--line)]"><table className="w-full min-w-[880px] text-sm"><thead className="bg-[var(--page)]"><tr>{['Select','Experiment','Status','Started','Duration','Seed','Fingerprint','Actions'].map((label) => <th key={label} className="text-left p-2.5 text-[11px] uppercase tracking-wide text-[var(--text-lo)]">{label}</th>)}</tr></thead><tbody>{filteredRuns.map((run) => <React.Fragment key={run.id}><tr className="border-t border-[var(--line)]"><td className="p-2.5"><input type="checkbox" checked={selectedRuns.includes(run.id)} onChange={() => toggleSelected(run.id)} aria-label={`Select ${run.name}`}/></td><td className="p-2.5"><button type="button" className="text-left font-semibold hover:underline" onClick={() => setExpandedRun((current) => current === run.id ? null : run.id)}>{run.name}</button><div className="text-[10px] text-[var(--text-lo)] font-mono">{run.kind} · {run.id.slice(0, 8)}</div></td><td className="p-2.5"><StatusPill status={run.status}/></td><td className="p-2.5 whitespace-nowrap text-xs">{dateText(run.startedAtUtc)}</td><td className="p-2.5 font-mono text-xs">{run.durationMs == null ? '—' : `${(run.durationMs / 1000).toFixed(1)} s`}</td><td className="p-2.5 font-mono text-xs">{run.seed ?? '—'}</td><td className="p-2.5"><span className="font-mono text-[10px]" title={run.configurationFingerprint}>{run.configurationFingerprint.slice(0, 12)}…</span></td><td className="p-2.5"><div className="flex items-center gap-1">{run.status === 'running' && ['phy_sweep', 'measurement_raytrace'].includes(run.kind) && typeof run.results.jobId === 'string' && <button type="button" title="Cancel running experiment" onClick={() => void cancelRun(run)} disabled={busyId === run.id} className="rounded p-1.5 hover:bg-rose-50 text-rose-700 disabled:opacity-40"><Square className="w-4 h-4"/></button>}{run.replay && <button type="button" title="Retry this experiment" onClick={() => void retryRun(run)} disabled={busyId === run.id || run.status === 'running'} className="rounded p-1.5 hover:bg-[var(--panel-soft)] disabled:opacity-40"><RotateCcw className="w-4 h-4"/></button>}{run.kind === 'measurement_raytrace' && Array.isArray(run.results.validationRows) && <button type="button" title="Generate validation report" onClick={() => downloadValidationReport(run)} className="rounded p-1.5 hover:bg-[var(--panel-soft)]"><FileText className="w-4 h-4"/></button>}<button type="button" title="Delete run" onClick={() => void removeRun(run)} disabled={busyId === run.id} className="rounded p-1.5 hover:bg-rose-50 text-rose-700 disabled:opacity-40"><Trash2 className="w-4 h-4"/></button></div></td></tr>{expandedRun === run.id && <tr className="border-t border-[var(--line)] bg-[var(--page)]"><td colSpan={8} className="p-3"><div className="grid grid-cols-1 xl:grid-cols-2 gap-3"><div><h4 className="eyebrow mb-2">Parameters &amp; configuration</h4><pre className="max-h-72 overflow-auto rounded bg-[var(--panel)] p-3 text-[10px] leading-relaxed">{JSON.stringify({ configuration: run.configuration, parameters: run.parameters, error: run.error, replay: run.replay }, null, 2)}</pre></div><div><h4 className="eyebrow mb-2">Results</h4><pre className="max-h-72 overflow-auto rounded bg-[var(--panel)] p-3 text-[10px] leading-relaxed">{JSON.stringify(run.results, null, 2)}</pre></div></div></td></tr>}</React.Fragment>)}</tbody></table></div>}
        <div className="text-xs text-[var(--text-lo)]">Selected for comparison: {selectedRuns.length}. To generate a report, open the corresponding measurement ray-trace record.</div>
      </div>}

      {view === 'presets' && <div className="grid grid-cols-1 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)] gap-4">
        <div className="rounded-lg border border-[var(--line)] p-4 flex flex-col gap-3"><div className="flex items-center gap-2"><FlaskConical className="w-5 h-5 text-[var(--accent)]"/><h3 className="font-semibold">Save current RF configuration</h3></div><p className="text-xs text-[var(--text-lo)]">Stores the active TX/RX, carrier frequency, maximum depth, solver interactions, and materials. Applying a preset does not modify scene geometry.</p><label className="text-xs flex flex-col gap-1">Preset name<input value={presetName} onChange={(event) => setPresetName(event.target.value)} maxLength={100} placeholder="e.g. n78 — calibrated candidate" className="rounded-md border border-[var(--line)] bg-[var(--page)] px-3 py-2 text-sm"/></label><label className="text-xs flex flex-col gap-1">Description<textarea value={presetDescription} onChange={(event) => setPresetDescription(event.target.value)} maxLength={500} rows={3} placeholder="A short note about this RF setup…" className="rounded-md border border-[var(--line)] bg-[var(--page)] px-3 py-2 text-sm resize-y"/></label><button type="button" onClick={() => void savePreset()} disabled={!backendOnline || busy || !presetName.trim()} className="rounded-md bg-[var(--accent)] text-white px-3 py-2 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50"><Plus className="w-4 h-4"/> Save RF preset</button></div>
        <div className="flex flex-col gap-2">{presets.length === 0 ? <div className="rounded-lg border border-dashed border-[var(--line)] p-8 text-center text-sm text-[var(--text-lo)]">No configuration presets have been saved yet.</div> : presets.map((preset) => <div key={preset.id} className="rounded-lg border border-[var(--line)] p-3 flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 flex-1"><div className="font-semibold">{preset.name}</div><p className="text-xs text-[var(--text-lo)] mt-0.5">{preset.description || 'No description'}</p><div className="font-mono text-[10px] text-[var(--text-lo)] mt-1">{preset.configurationFingerprint.slice(0, 20)}… · updated {dateText(preset.updatedAtUtc)}</div><div className="text-xs mt-1">{pretty(preset.configuration.freqGhz)} GHz · depth {pretty(preset.configuration.maxDepth)} · TX {pretty((preset.configuration.tx as any)?.name)} · RX {pretty((preset.configuration.rx as any)?.name)}</div></div><div className="flex items-center gap-2"><button type="button" onClick={() => { onApplyConfiguration(preset.configuration); setMessage(`Preset “${preset.name}” applied. Verify TX/RX and scene geometry before running a calculation.`); }} className="rounded-md border border-[var(--line)] px-3 py-2 text-xs font-semibold flex items-center gap-1.5"><Play className="w-3.5 h-3.5"/> Apply</button><button type="button" onClick={() => void removePreset(preset)} disabled={busyId === preset.id} className="rounded-md p-2 text-rose-700 hover:bg-rose-50 disabled:opacity-40"><Trash2 className="w-4 h-4"/></button></div></div>)}</div>
      </div>}

      {view === 'compare' && <div className="flex flex-col gap-3"><div className="text-sm text-[var(--text-mid)]">Select at least two experiments in Run History. The comparison shows shared scalar parameters and results; interpret different calculation types separately.</div>{selected.length < 2 ? <div className="rounded-lg border border-dashed border-[var(--line)] p-8 text-center text-sm text-[var(--text-lo)]">Select at least two experiments in Run History.</div> : <><div className="overflow-x-auto rounded-lg border border-[var(--line)]"><table className="w-full min-w-[760px] text-xs"><thead className="bg-[var(--page)]"><tr><th className="text-left p-2">Parameter / metric</th>{selected.map((run) => <th key={run.id} className="text-left p-2 min-w-40">{run.name}<div className="font-normal text-[var(--text-lo)]">{run.kind}</div></th>)}</tr></thead><tbody>{comparablePaths.map((path) => <tr key={path} className="border-t border-[var(--line)]"><td className="p-2 font-mono text-[var(--text-mid)]">{path}</td>{selected.map((run) => { const flat = new Map([...flattenScalars(run.configuration, 'configuration'), ...flattenScalars(run.parameters, 'parameters'), ...flattenScalars(run.results, 'results')]); return <td key={run.id} className="p-2 font-mono">{flat.get(path) ?? '—'}</td>; })}</tr>)}</tbody></table></div><div className="text-xs text-[var(--text-lo)]">Fingerprint match: {new Set(selected.map((run) => run.configurationFingerprint)).size === 1 ? 'all selected runs share an identical configuration fingerprint' : 'configurations differ — inspect parameters before attributing result changes'}</div></>}</div>}

      {view === 'reports' && <div className="flex flex-col gap-3"><div className="text-sm text-[var(--text-mid)]">The validation report is generated from a saved Measurement Ray Trace experiment. It includes the RF snapshot, sampled locations, measured RSRP, simulated total received power, and warnings.</div>{runs.filter((run) => run.kind === 'measurement_raytrace' && Array.isArray(run.results.validationRows)).length === 0 ? <div className="rounded-lg border border-dashed border-[var(--line)] p-8 text-center text-sm text-[var(--text-lo)]">No saved Measurement Ray Trace results are available yet.</div> : runs.filter((run) => run.kind === 'measurement_raytrace' && Array.isArray(run.results.validationRows)).map((run) => <div key={run.id} className="rounded-lg border border-[var(--line)] p-3 flex flex-wrap items-center justify-between gap-3"><div><div className="font-semibold">{run.name}</div><div className="text-xs text-[var(--text-lo)] mt-1">{dateText(run.completedAtUtc)} · {pretty(run.results.sampleCountReturned)} sample points · {pretty(run.results.validSimulationCount)} with paths</div><div className="font-mono text-[10px] text-[var(--text-lo)]">{run.configurationFingerprint.slice(0, 24)}…</div></div><button type="button" onClick={() => downloadValidationReport(run)} className="rounded-md bg-[var(--accent)] text-white px-3 py-2 text-xs font-semibold flex items-center gap-2"><ArrowDownToLine className="w-4 h-4"/> Generate HTML report</button></div>)}</div>}
    </section>
  );
}
