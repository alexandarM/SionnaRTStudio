// Modified in the alexandarM/SionnaRTStudio fork of the original project.
// Phase 2: safe Mitsuba XML/ZIP inventory and non-activating geometry preview.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AlertTriangle, CheckCircle2, Clock3, Database, FileArchive, FileBox, Loader2, Trash2, Upload } from 'lucide-react';
import {
  activateImportedScene,
  clearSelectedImportedScene,
  deleteImportedScene,
  getImportedScene,
  getIndoorSceneMaterialCatalog,
  getIndoorSceneRuntimeStatus,
  listImportedSceneSessions,
  previewImportedScene,
  selectImportedScene,
  ImportedSceneObject,
  SceneCoordinateProfile,
  SceneImportPreview,
  SceneImportSessionList,
  SionnaMaterialCatalog,
  IndoorSceneRuntimeStatus,
} from '../api';
import type { Receiver, SolverOptions, Transmitter } from '../types';

type SignedAxis = SceneCoordinateProfile['upAxis'];
const SIGNED_AXES: SignedAxis[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const UNIT_OPTIONS: Array<{ value: SceneCoordinateProfile['units']; label: string }> = [
  { value: 'm', label: 'Metres (m)' },
  { value: 'cm', label: 'Centimetres (cm)' },
  { value: 'mm', label: 'Millimetres (mm)' },
  { value: 'ft', label: 'Feet (ft)' },
  { value: 'in', label: 'Inches (in)' },
  { value: 'custom', label: 'Custom scale' },
];

function ImportPreview3D({ url, sessionId }: { url: string; sessionId: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState('Loading geometry preview…');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let frameHandle = 0;
    let resizeObserver: ResizeObserver | null = null;
    let controls: OrbitControls | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let loadedRoot: THREE.Object3D | null = null;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#111820');
    scene.add(new THREE.HemisphereLight(0xffffff, 0x46515c, 2.0));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(8, -10, 15);
    scene.add(keyLight);

    const width = Math.max(host.clientWidth, 320);
    const height = Math.max(host.clientHeight, 280);
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.01, 5000);
    camera.up.set(0, 0, 1); // Preview GLB is already transformed to canonical Z-up.
    camera.position.set(8, -10, 8);

    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(width, height);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      host.replaceChildren(renderer.domElement);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.screenSpacePanning = true;
      controls.maxPolarAngle = Math.PI * 0.98;

      const grid = new THREE.GridHelper(20, 20, 0x627080, 0x34414d);
      grid.rotation.x = Math.PI / 2;
      grid.position.z = 0;
      scene.add(grid);
      const axes = new THREE.AxesHelper(2);
      scene.add(axes);

      const loader = new GLTFLoader();
      loader.load(
        url,
        (gltf) => {
          if (disposed) {
            gltf.scene.traverse((node) => {
              const mesh = node as THREE.Mesh;
              if (mesh.geometry) mesh.geometry.dispose();
            });
            return;
          }
          loadedRoot = gltf.scene;
          scene.add(gltf.scene);
          const bounds = new THREE.Box3().setFromObject(gltf.scene);
          const size = bounds.getSize(new THREE.Vector3());
          const center = bounds.getCenter(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z, 0.5);
          controls!.target.copy(center);
          camera.near = Math.max(0.001, maxDim / 3000);
          camera.far = Math.max(100, maxDim * 100);
          camera.position.set(
            center.x + maxDim * 1.55,
            center.y - maxDim * 1.9,
            center.z + maxDim * 1.35,
          );
          camera.lookAt(center);
          camera.updateProjectionMatrix();
          controls!.update();
          grid.scale.setScalar(Math.max(1, maxDim / 10));
          grid.position.set(center.x, center.y, bounds.min.z);
          axes.position.copy(bounds.min);
          axes.scale.setScalar(Math.max(0.5, maxDim / 3));
          setStatus(`${gltf.scene.children.length.toLocaleString()} top-level preview groups · orbit to inspect`);
        },
        (event) => {
          if (!disposed && event.total > 0) {
            const percent = Math.round((event.loaded / event.total) * 100);
            setStatus(`Loading geometry preview… ${percent}%`);
          }
        },
        (error) => {
          console.error('Scene import GLB preview failed', error);
          setStatus('3D preview failed to load. The inventory below remains available.');
        },
      );

      const resize = () => {
        if (!host || !renderer) return;
        const w = Math.max(host.clientWidth, 320);
        const h = Math.max(host.clientHeight, 280);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      const animate = () => {
        if (disposed || !renderer) return;
        frameHandle = window.requestAnimationFrame(animate);
        controls?.update();
        renderer.render(scene, camera);
      };
      animate();
    } catch (error) {
      console.error('Could not create scene import preview renderer', error);
      setStatus(error instanceof Error ? error.message : String(error));
    }

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameHandle);
      resizeObserver?.disconnect();
      controls?.dispose();
      if (loadedRoot) {
        loadedRoot.traverse((node) => {
          const mesh = node as THREE.Mesh;
          mesh.geometry?.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
          materials.forEach((material) => material.dispose());
        });
      }
      scene.traverse((node) => {
        if (node instanceof THREE.GridHelper || node instanceof THREE.AxesHelper) {
          node.geometry.dispose();
          const material = Array.isArray(node.material) ? node.material : [node.material];
          material.forEach((entry) => entry.dispose());
        }
      });
      renderer?.dispose();
      renderer?.forceContextLoss();
      host.replaceChildren();
    };
  }, [url, sessionId]);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[#111820]">
      <div ref={hostRef} className="w-full" style={{ height: 440 }} />
      <div className="px-3 py-2 border-t border-white/10 text-[11px] text-slate-300 flex items-center justify-between gap-3">
        <span>{status}</span>
        <span className="font-mono shrink-0">X / Y / Z · Z-up preview</span>
      </div>
    </div>
  );
}


function linearChannelToSrgb(value: number): number {
  const channel = Math.max(0, Math.min(1, value));
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

function materialPreviewCss(material: SceneImportPreview['materials'][number]): string {
  const color = material.previewColorLinear;
  if (!color || color.length !== 3) return 'rgb(184 184 184)';
  const srgb = color.map((value) => Math.round(linearChannelToSrgb(value) * 255));
  return `rgb(${srgb[0]} ${srgb[1]} ${srgb[2]})`;
}

function formatBounds(bounds: ImportedSceneObject['canonicalBounds']): string {
  if (!bounds) return '—';
  const fmt = (values: number[]) => values.map((value) => value.toFixed(2)).join(', ');
  return `[${fmt(bounds.minimum)}] → [${fmt(bounds.maximum)}] m`;
}

type SceneImportPanelProps = {
  onActiveSceneChange?: (scene: SceneImportPreview | null) => void;
  txs: Transmitter[];
  rxs: Receiver[];
  solverOptions: SolverOptions;
  applicationFrequencyGhz: number;
};

export function SceneImportPanel({
  onActiveSceneChange,
  txs,
  rxs,
  solverOptions,
  applicationFrequencyGhz,
}: SceneImportPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [upAxis, setUpAxis] = useState<SignedAxis | ''>('');
  const [forwardAxis, setForwardAxis] = useState<SignedAxis | ''>('');
  const [units, setUnits] = useState<SceneCoordinateProfile['units'] | ''>('');
  const [handedness, setHandedness] = useState<SceneCoordinateProfile['handedness'] | ''>('');
  const [customScale, setCustomScale] = useState('');
  const [origin, setOrigin] = useState<[string, string, string]>(['0', '0', '0']);
  const [preview, setPreview] = useState<SceneImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showAllObjects, setShowAllObjects] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sessionList, setSessionList] = useState<SceneImportSessionList | null>(null);
  const [managerBusy, setManagerBusy] = useState(false);
  const [materialCatalog, setMaterialCatalog] = useState<SionnaMaterialCatalog | null>(null);
  const [materialMappings, setMaterialMappings] = useState<Record<string, string>>({});
  const [carrierFrequencyGhz, setCarrierFrequencyGhz] = useState('28');
  const [activationBusy, setActivationBusy] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<IndoorSceneRuntimeStatus | null>(null);
  const mappingSessionIdRef = useRef<string | null>(null);

  const refreshSessions = async () => {
    const result = await listImportedSceneSessions();
    setSessionList(result);
    return result;
  };

  useEffect(() => {
    let cancelled = false;
    const restoreManager = async () => {
      try {
        const result = await listImportedSceneSessions();
        if (cancelled) return;
        setSessionList(result);
        const [catalogResult, runtimeResult] = await Promise.allSettled([
          getIndoorSceneMaterialCatalog(),
          getIndoorSceneRuntimeStatus(),
        ]);
        if (cancelled) return;
        if (catalogResult.status === 'fulfilled') setMaterialCatalog(catalogResult.value);
        else setError(catalogResult.reason instanceof Error ? catalogResult.reason.message : String(catalogResult.reason));
        if (runtimeResult.status === 'fulfilled') setRuntimeStatus(runtimeResult.value);
        if (result.selectedSessionId) {
          const selected = await getImportedScene(result.selectedSessionId);
          if (!cancelled) { setPreview(selected); onActiveSceneChange?.(selected); }
        } else if (!cancelled) {
          onActiveSceneChange?.(null);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void restoreManager();
    return () => { cancelled = true; };
  }, [onActiveSceneChange]);

  useEffect(() => {
    if (!preview || !materialCatalog || mappingSessionIdRef.current === preview.sessionId) return;
    const valid = new Set(materialCatalog.materials.map((item) => item.name));
    const frequency = Number(carrierFrequencyGhz);
    const initial: Record<string, string> = {};
    preview.materials.filter((item) => item.isReferenced).forEach((item) => {
      const hint = item.nameHint === 'floor_board' ? 'floorboard' : item.nameHint;
      const candidate = hint && valid.has(hint) ? materialCatalog.materials.find((entry) => entry.name === hint) : undefined;
      const supported = candidate?.frequencyRangesGhz.some((range) => frequency >= range.minimum && frequency <= range.maximum);
      if (supported) initial[item.id] = candidate!.name;
    });
    mappingSessionIdRef.current = preview.sessionId;
    setMaterialMappings(initial);
  }, [preview?.sessionId, materialCatalog]);

  const forwardOptions = useMemo(
    () => SIGNED_AXES.filter((axis) => !upAxis || axis[1] !== upAxis[1]),
    [upAxis],
  );

  useEffect(() => {
    if (forwardAxis && upAxis && forwardAxis[1] === upAxis[1]) setForwardAxis('');
  }, [upAxis, forwardAxis]);

  const onSelectFile = (next: File | null) => {
    // Selecting a new upload must not destroy a scene already stored in the
    // manager. Staged sessions are intentionally retained until explicit delete/TTL.
    setError('');
    setPreview(null);
    setFile(next);
  };

  const handlePreview = async () => {
    setError('');
    if (!file) return setError('Choose a ZIP archive first.');
    if (!upAxis || !forwardAxis || !units || !handedness) {
      return setError('Select the source up axis, forward axis, units and handedness. The importer never assumes these values.');
    }
    const originValues = origin.map((value) => Number(value));
    if (originValues.some((value) => !Number.isFinite(value))) return setError('Origin must contain three finite numbers.');
    const customValue = units === 'custom' ? Number(customScale) : null;
    if (units === 'custom' && (!Number.isFinite(customValue) || (customValue ?? 0) <= 0)) {
      return setError('Custom scale must be a positive number of metres per source unit.');
    }
    const profile: SceneCoordinateProfile = {
      upAxis,
      forwardAxis,
      units,
      handedness,
      customScaleToMeters: customValue,
      origin: originValues as [number, number, number],
    };
    setBusy(true);
    try {
      const result = await previewImportedScene(file, profile);
      setPreview(result);
      setShowAllObjects(false);
      await refreshSessions();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleSelectPreview = async () => {
    if (!preview) return;
    setManagerBusy(true);
    setError('');
    try {
      const selected = await selectImportedScene(preview.sessionId);
      const runtime = await getIndoorSceneRuntimeStatus();
      setRuntimeStatus(runtime);
      setPreview(selected);
      onActiveSceneChange?.(selected);
      await refreshSessions();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setManagerBusy(false);
    }
  };

  const handleSelectSession = async (sessionId: string) => {
    setManagerBusy(true);
    setError('');
    try {
      const selected = await selectImportedScene(sessionId);
      const runtime = await getIndoorSceneRuntimeStatus();
      setRuntimeStatus(runtime);
      setPreview(selected);
      onActiveSceneChange?.(selected);
      setFile(null);
      setShowAllObjects(false);
      await refreshSessions();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setManagerBusy(false);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    setManagerBusy(true);
    setError('');
    try {
      await deleteImportedScene(sessionId);
      const runtime = await getIndoorSceneRuntimeStatus();
      setRuntimeStatus(runtime);
      if (preview?.sessionId === sessionId) setPreview(null);
      const refreshed = await refreshSessions();
      if (!refreshed.selectedSessionId) onActiveSceneChange?.(null);
      else onActiveSceneChange?.(await getImportedScene(refreshed.selectedSessionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setManagerBusy(false);
    }
  };

  const handleClear = async () => {
    setManagerBusy(true);
    try {
      await clearSelectedImportedScene();
      setRuntimeStatus(await getIndoorSceneRuntimeStatus());
      setPreview(null);
      setFile(null);
      setError('');
      await refreshSessions();
      onActiveSceneChange?.(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setManagerBusy(false);
    }
  };

  const handleActivateScene = async () => {
    if (!preview) return;
    if (!preview.sceneManager?.selected) {
      setError('Select this scene in the Scene Manager before activating it in Sionna RT.');
      return;
    }
    const frequency = Number(carrierFrequencyGhz);
    if (!Number.isFinite(frequency) || frequency <= 0 || frequency > 300) {
      setError('Carrier frequency must be a number between 0 and 300 GHz.');
      return;
    }
    const referenced = preview.materials.filter((material) => material.isReferenced);
    const missing = referenced.filter((material) => !materialMappings[material.id]);
    if (missing.length) {
      setError(`Map all referenced materials before activation: ${missing.map((item) => item.id).join(', ')}`);
      return;
    }
    const invalid = referenced.filter((material) => {
      const selected = materialCatalog?.materials.find((entry) => entry.name === materialMappings[material.id]);
      return !selected || !selected.frequencyRangesGhz.some((range) => frequency >= range.minimum && frequency <= range.maximum);
    });
    if (invalid.length) {
      setError(`The selected material mapping does not support ${frequency} GHz: ${invalid.map((item) => item.id).join(', ')}.`);
      return;
    }
    setActivationBusy(true);
    setError('');
    try {
      const runtime = await activateImportedScene(preview.sessionId, {
        carrierFrequencyGhz: frequency,
        materialMappings: Object.fromEntries(referenced.map((item) => [item.id, materialMappings[item.id]])),
      });
      setRuntimeStatus(runtime);
      const activated = await getImportedScene(preview.sessionId);
      setPreview(activated);
      onActiveSceneChange?.(activated);
      await refreshSessions();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      try { setRuntimeStatus(await getIndoorSceneRuntimeStatus()); } catch { /* keep prior status */ }
    } finally {
      setActivationBusy(false);
    }
  };

  const dropFile = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) onSelectFile(dropped);
  };

  return (
    <div className="flex flex-col gap-5 min-w-0">
      <section className="panel p-5 md:p-6 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-[var(--accent)]" />
            <div>
              <h3 className="font-semibold text-[var(--text-hi)]">Persistent Scene Manager</h3>
              <p className="text-xs text-[var(--text-lo)]">Staged scenes are retained in the backend cache and can be restored after a browser refresh or backend process restart while the cache directory remains available.</p>
            </div>
          </div>
          {sessionList && <span className="text-xs text-[var(--text-mid)]">{sessionList.cache.sessionCount} / {sessionList.cache.maxSessions} scenes · {(sessionList.cache.storedBytes / (1024 * 1024)).toFixed(1)} MB · {sessionList.cache.cacheHits} cache hits</span>}
        </div>
        {sessionList && sessionList.sessions.length > 0 ? (
          <div className="flex flex-col gap-2">
            {sessionList.sessions.map((session) => (
              <div key={session.sessionId} className={`rounded-lg border p-3 flex items-center justify-between gap-3 flex-wrap ${session.selected ? 'border-[var(--accent)]/60 bg-[var(--accent)]/5' : 'border-[var(--line)] bg-[var(--ink-750)]'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-[var(--text-hi)] truncate">{session.archiveName}</span>
                    {session.selected ? <span className="text-[10px] rounded-full px-2 py-1 border border-emerald-400/30 text-emerald-300">Selected</span> : <span className="text-[10px] rounded-full px-2 py-1 border border-[var(--line)] text-[var(--text-lo)]">Staged</span>}
                  </div>
                  <div className="text-[11px] text-[var(--text-lo)] font-mono mt-1">{session.xmlPath} · {session.stats.shapeCount} objects · {session.stats.materialCount} materials · {(session.storedBytes / (1024 * 1024)).toFixed(2)} MB</div>
                  <div className="text-[10px] text-[var(--text-lo)] mt-1 flex items-center gap-1"><Clock3 className="w-3 h-3"/> Last used {new Date(session.lastAccessedAt).toLocaleString()}</div>
                </div>
                <div className="flex items-center gap-2">
                  {!session.selected && <button type="button" disabled={managerBusy} onClick={() => void handleSelectSession(session.sessionId)} className="px-3 py-2 rounded-lg border border-[var(--line)] text-xs text-[var(--text-mid)] hover:text-[var(--text-hi)] disabled:opacity-50">Select</button>}
                  <button type="button" disabled={managerBusy} onClick={() => void handleDeleteSession(session.sessionId)} className="px-2.5 py-2 rounded-lg border border-red-500/30 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50" title="Delete staged scene"><Trash2 className="w-3.5 h-3.5"/></button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-[var(--text-lo)]">No staged scenes are currently stored.</p>
        )}
        <p className="text-[11px] text-[var(--text-lo)]">Selecting a scene only marks it as the current staged indoor scene. It does not load or replace the active Sionna RT scene. Cache policy: {sessionList?.cache.ttlHours ?? 12} h TTL, LRU eviction, maximum {sessionList?.cache.maxSessions ?? 4} scenes.</p>
      </section>

      <section className="panel p-5 md:p-6 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="eyebrow mb-1">Phase 2 / 3 · Import and staged scene lifecycle</div>
            <h2 className="text-xl font-semibold text-[var(--text-hi)]">Indoor / arbitrary 3D scene import</h2>
            <p className="text-sm text-[var(--text-mid)] mt-1 max-w-3xl">
              Upload one Mitsuba XML scene together with every referenced mesh and texture. The Scene Manager retains validated scene resources and preview state; Sionna RT activation remains a separate later phase.
            </p>
          </div>
          <span className="text-[11px] rounded-full border border-[var(--line)] px-3 py-1.5 text-[var(--text-mid)]">Import / preview / Sionna RT activation</span>
        </div>

        <div
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={dropFile}
          className={`rounded-xl border-2 border-dashed p-6 flex flex-col items-center text-center gap-3 transition-colors ${dragging ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--line)] bg-[var(--ink-750)]'}`}
        >
          <div className="w-12 h-12 rounded-xl grid place-items-center bg-[var(--ink-750)] border border-[var(--line)]">
            <FileArchive className="w-6 h-6 text-[var(--accent)]" />
          </div>
          <div>
            <div className="font-medium text-[var(--text-hi)]">{file ? file.name : 'Drop a scene ZIP here'}</div>
            <p className="text-xs text-[var(--text-lo)] mt-1">One Mitsuba XML + referenced PLY / OBJ / STL / OFF meshes and textures · maximum upload 250 MB</p>
          </div>
          <label className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium cursor-pointer bg-[var(--ink-750)] border border-[var(--line)] hover:border-[var(--accent)] text-[var(--text-hi)]">
            <Upload className="w-4 h-4" /> Choose ZIP
            <input type="file" accept=".zip,application/zip" className="hidden" onChange={(event) => onSelectFile(event.target.files?.[0] ?? null)} />
          </label>
        </div>

        <div className="border-t border-[var(--line)] pt-4 flex flex-col gap-3">
          <div>
            <h3 className="font-medium text-[var(--text-hi)]">Source coordinate profile</h3>
            <p className="text-xs text-[var(--text-lo)] mt-1">These values describe the uploaded source scene, not a fixed indoor convention. Choose them explicitly for every new scene.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <label className="flex flex-col gap-1 text-xs text-[var(--text-mid)]">
              Up axis
              <select value={upAxis} onChange={(event) => setUpAxis(event.target.value as SignedAxis | '')} className="scene-import-field">
                <option value="">Select up axis…</option>
                {SIGNED_AXES.map((axis) => <option key={axis} value={axis}>{axis}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-mid)]">
              Forward axis
              <select value={forwardAxis} onChange={(event) => setForwardAxis(event.target.value as SignedAxis | '')} className="scene-import-field">
                <option value="">Select forward axis…</option>
                {forwardOptions.map((axis) => <option key={axis} value={axis}>{axis}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-mid)]">
              Source units
              <select value={units} onChange={(event) => setUnits(event.target.value as SceneCoordinateProfile['units'] | '')} className="scene-import-field">
                <option value="">Select units…</option>
                {UNIT_OPTIONS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-mid)]">
              Handedness
              <select value={handedness} onChange={(event) => setHandedness(event.target.value as SceneCoordinateProfile['handedness'] | '')} className="scene-import-field">
                <option value="">Select handedness…</option>
                <option value="right">Right-handed</option>
                <option value="left">Left-handed</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="flex flex-col gap-1 text-xs text-[var(--text-mid)]">
              Source origin X / Y / Z
              <div className="grid grid-cols-3 gap-2">
                {origin.map((value, index) => (
                  <input key={index} type="number" step="any" value={value} aria-label={`Source origin ${'XYZ'[index]}`} onChange={(event) => setOrigin((current) => current.map((entry, i) => i === index ? event.target.value : entry) as [string, string, string])} className="scene-import-field min-w-0" />
                ))}
              </div>
            </div>
            {units === 'custom' && (
              <label className="flex flex-col gap-1 text-xs text-[var(--text-mid)]">
                Metres per source unit
                <input type="number" min="0" step="any" value={customScale} onChange={(event) => setCustomScale(event.target.value)} placeholder="e.g. 0.001" className="scene-import-field" />
              </label>
            )}
            <div className="sm:col-span-2 flex items-end gap-2 flex-wrap">
              <button type="button" onClick={handlePreview} disabled={busy || !file} className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[var(--accent)] text-white font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileBox className="w-4 h-4" />}
                {busy ? 'Inspecting scene…' : 'Import and preview'}
              </button>
              {preview && <button type="button" disabled={managerBusy} onClick={handleClear} className="inline-flex items-center gap-2 px-3 py-2.5 rounded-lg border border-[var(--line)] text-sm text-[var(--text-mid)] hover:text-[var(--text-hi)] disabled:opacity-50"><Trash2 className="w-4 h-4"/> Clear selection</button>}
            </div>
          </div>
        </div>
        {error && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>}
      </section>

      {preview && (
        <>
          <section className="panel p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                <div>
                  <h3 className="font-semibold text-[var(--text-hi)]">Scene archive validated</h3>
                  <p className="text-xs text-[var(--text-lo)]">{preview.xmlPath} · Mitsuba scene version {preview.sceneVersion ?? 'unknown'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {preview.cacheHit && <span className="text-xs rounded-full px-2.5 py-1.5 border border-sky-400/30 text-sky-200">Reused from cache</span>}
                {preview.sceneManager?.selected
                  ? <span className="text-xs rounded-full px-3 py-1.5 border border-emerald-400/30 text-emerald-300">Selected in Scene Manager</span>
                  : <button type="button" disabled={managerBusy} onClick={() => void handleSelectPreview()} className="text-xs rounded-lg px-3 py-1.5 border border-[var(--accent)]/50 text-[var(--accent)] hover:bg-[var(--accent)]/5 disabled:opacity-50">Select in Scene Manager</button>}
                {runtimeStatus?.active && runtimeStatus.sessionId === preview.sessionId
                  ? <span className="text-xs rounded-full px-3 py-1.5 border border-emerald-400/30 text-emerald-300">Active in Sionna RT</span>
                  : <span className="text-xs rounded-full px-3 py-1.5 border border-amber-400/30 text-amber-200">Not loaded into Sionna RT</span>}
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-2">
              {[
                ['Shape objects', preview.stats.shapeCount],
                ['Meshes previewed', preview.stats.previewedShapeCount],
                ['Materials', preview.stats.materialCount],
                ['Resources', preview.stats.resourceCount],
                ['Vertices', preview.stats.totalVertices.toLocaleString()],
                ['Faces', preview.stats.totalFaces.toLocaleString()],
                ['Textures', preview.stats.textureCount],
                ['Unsupported shapes', preview.stats.unsupportedShapeCount],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-[var(--line)] bg-[var(--ink-750)] p-3">
                  <div className="text-[10px] uppercase tracking-wide text-[var(--text-lo)]">{label}</div>
                  <div className="text-lg font-semibold tabular-nums text-[var(--text-hi)] mt-1">{value}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(260px,0.8fr)] gap-4">
              <div className="min-w-0">
                <h4 className="text-sm font-medium text-[var(--text-hi)] mb-2">Canonical geometry preview</h4>
                {preview.previewUrl ? <ImportPreview3D sessionId={preview.sessionId} url={preview.previewUrl} /> : <div className="rounded-lg border border-[var(--line)] p-6 text-sm text-[var(--text-mid)]">A GLB preview could not be generated. See warnings below; material and geometry inventory is still available.</div>}
              </div>
              <div className="flex flex-col gap-3">
                <div className="rounded-lg border border-[var(--line)] bg-[var(--ink-750)] p-3">
                  <div className="text-xs font-medium text-[var(--text-hi)] mb-2">Applied coordinate profile</div>
                  <div className="grid grid-cols-2 gap-y-1 text-xs">
                    <span className="text-[var(--text-lo)]">Source up</span><span className="text-right font-mono">{preview.coordinateFrame.upAxis}</span>
                    <span className="text-[var(--text-lo)]">Source forward</span><span className="text-right font-mono">{preview.coordinateFrame.forwardAxis}</span>
                    <span className="text-[var(--text-lo)]">Units</span><span className="text-right">{preview.coordinateFrame.units}</span>
                    <span className="text-[var(--text-lo)]">Handedness</span><span className="text-right">{preview.coordinateFrame.handedness}</span>
                    <span className="text-[var(--text-lo)]">Scale to metres</span><span className="text-right font-mono">{preview.coordinateTransform.scaleToMeters}</span>
                    <span className="text-[var(--text-lo)]">Winding flip</span><span className="text-right">{preview.coordinateTransform.requiresWindingFlip ? 'Required' : 'Not required'}</span>
                  </div>
                </div>
                <div className="rounded-lg border border-[var(--line)] bg-[var(--ink-750)] p-3">
                  <div className="text-xs font-medium text-[var(--text-hi)] mb-2">Canonical bounds (metres)</div>
                  {preview.canonicalBounds ? (
                    <div className="font-mono text-[11px] leading-5 text-[var(--text-mid)]">
                      <div>X: {preview.canonicalBounds.minimum[0].toFixed(3)} … {preview.canonicalBounds.maximum[0].toFixed(3)}</div>
                      <div>Y: {preview.canonicalBounds.minimum[1].toFixed(3)} … {preview.canonicalBounds.maximum[1].toFixed(3)}</div>
                      <div>Z: {preview.canonicalBounds.minimum[2].toFixed(3)} … {preview.canonicalBounds.maximum[2].toFixed(3)}</div>
                    </div>
                  ) : <span className="text-xs text-[var(--text-lo)]">Bounds unavailable</span>}
                </div>
                <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-xs leading-5 text-sky-100">
                  {runtimeStatus?.active && runtimeStatus.sessionId === preview.sessionId
                    ? 'This scene is loaded in the current Sionna RT process. Viewport-placed TX/RX devices and their shared antenna arrays are applied automatically when you run a link or matrix solve.'
                    : 'This scene is staged for inspection. It is not loaded into Sionna RT until you complete the material mapping and activate it below.'}
                </div>
              </div>
            </div>
            {preview.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-amber-200 mb-2"><AlertTriangle className="w-4 h-4"/> Import warnings ({preview.warnings.length})</div>
                <ul className="list-disc pl-5 space-y-1 text-xs text-amber-100/90">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
              </div>
            )}
          </section>

          <section className="panel p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="font-semibold text-[var(--text-hi)]">Material inventory</h3>
                <p className="text-xs text-[var(--text-lo)]">Original XML IDs are preserved. Preview appearance is approximated from Mitsuba BSDFs; it is separate from Sionna RF material registration.</p>
              </div>
              <span className="text-xs text-[var(--text-mid)]">{preview.stats.referencedMaterialCount} referenced / {preview.stats.materialCount} declared</span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
              <table className="w-full text-xs min-w-[650px]">
                <thead className="bg-[var(--ink-750)] text-[var(--text-lo)]"><tr><th className="text-left px-3 py-2">Original material ID</th><th className="text-left px-3 py-2">BSDF type</th><th className="text-left px-3 py-2">Preview appearance</th><th className="text-left px-3 py-2">Name hint</th><th className="text-right px-3 py-2">Objects</th><th className="text-right px-3 py-2">Reference</th></tr></thead>
                <tbody>{preview.materials.map((material) => <tr key={material.id} className="border-t border-[var(--line)]"><td className="px-3 py-2 font-mono text-[var(--text-hi)]">{material.id}</td><td className="px-3 py-2 text-[var(--text-mid)]">{material.bsdfType}</td><td className="px-3 py-2"><div className="flex items-center gap-2"><span className="inline-block w-5 h-5 rounded border border-black/20 shadow-inner" style={{ backgroundColor: materialPreviewCss(material) }} title={material.previewSource ?? 'Fallback preview'} /><span className="text-[var(--text-mid)]">{material.previewTextureApplied ? 'Bitmap texture' : material.previewSource ?? 'Fallback'}</span></div>{material.previewTexturePath && <div className="text-[10px] text-[var(--text-lo)] font-mono mt-1">{material.previewTexturePath}{material.previewTextureApplied ? ' · applied' : ' · color fallback'}</div>}{(material.previewWarnings?.length ?? 0) > 0 && <div className="text-[10px] text-amber-300 mt-1">{material.previewWarnings?.[0]}</div>}</td><td className="px-3 py-2">{material.nameHint ?? <span className="text-[var(--text-lo)]">No hint</span>}</td><td className="px-3 py-2 text-right tabular-nums">{material.shapeCount}</td><td className="px-3 py-2 text-right">{material.isReferenced ? 'Yes' : 'Unused'}</td></tr>)}</tbody>
              </table>
            </div>
          </section>

          <section className="panel p-5 flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="eyebrow mb-1">Phase 6.1 · Sionna RT scene activation</div>
                <h3 className="font-semibold text-[var(--text-hi)]">Radio-material mapping and activation</h3>
                <p className="text-xs text-[var(--text-lo)] mt-1 max-w-3xl">Map every referenced original XML material ID to a material supported by the installed Sionna RT version. The activation step bakes the universal coordinate transform into the mesh files and loads every shape as an individual Sionna scene object.</p>
              </div>
              {runtimeStatus?.active && runtimeStatus.sessionId === preview.sessionId
                ? <span className="text-xs rounded-full px-3 py-1.5 border border-emerald-400/30 text-emerald-300">Runtime active</span>
                : <span className="text-xs rounded-full px-3 py-1.5 border border-amber-400/30 text-amber-200">Awaiting activation</span>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="flex flex-col gap-1 text-xs text-[var(--text-mid)]">Carrier frequency (GHz)
                <input type="number" min="0.001" max="300" step="any" value={carrierFrequencyGhz} onChange={(event) => setCarrierFrequencyGhz(event.target.value)} className="scene-import-field" />
              </label>
              <div className="sm:col-span-2 rounded-lg border border-[var(--line)] bg-[var(--ink-750)] p-3 text-xs leading-5 text-[var(--text-mid)] self-end">
                {materialCatalog
                  ? <>{materialCatalog.runtime} {materialCatalog.version} · Mitsuba variant <span className="font-mono">{materialCatalog.mitsubaVariant}</span> · {materialCatalog.materials.length} ITU materials discovered from this runtime.</>
                  : 'Reading the installed Sionna RT material catalogue…'}
              </div>
            </div>
            {preview.materials.filter((material) => material.isReferenced).length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
                <table className="w-full text-xs min-w-[600px]">
                  <thead className="bg-[var(--ink-750)] text-[var(--text-lo)]"><tr><th className="text-left px-3 py-2">Original material ID</th><th className="text-left px-3 py-2">Sionna ITU material</th><th className="text-right px-3 py-2">Objects</th><th className="text-left px-3 py-2">Frequency validity</th></tr></thead>
                  <tbody>{preview.materials.filter((material) => material.isReferenced).map((material) => {
                    const selected = materialCatalog?.materials.find((entry) => entry.name === materialMappings[material.id]);
                    const frequency = Number(carrierFrequencyGhz);
                    const supported = selected?.frequencyRangesGhz.some((range) => frequency >= range.minimum && frequency <= range.maximum) ?? false;
                    return <tr key={material.id} className="border-t border-[var(--line)]">
                      <td className="px-3 py-2 font-mono text-[var(--text-hi)]">{material.id}</td>
                      <td className="px-3 py-2"><select value={materialMappings[material.id] ?? ''} onChange={(event) => setMaterialMappings((current) => ({ ...current, [material.id]: event.target.value }))} className="scene-import-field min-w-[180px]">
                        <option value="">Select ITU material…</option>
                        {materialCatalog?.materials.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
                      </select></td>
                      <td className="px-3 py-2 text-right tabular-nums">{material.shapeCount}</td>
                      <td className={`px-3 py-2 ${supported ? 'text-emerald-300' : 'text-amber-300'}`}>{selected ? (supported ? 'Supported' : `Not valid at ${carrierFrequencyGhz} GHz`) : 'Mapping required'}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            )}
            {runtimeStatus?.active && runtimeStatus.sessionId === preview.sessionId && runtimeStatus.summary ? (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs leading-5 text-emerald-100">
                <div className="font-semibold mb-1">Sionna scene instantiated and registry checks passed</div>
                <div>{runtimeStatus.summary.registeredObjectCount} objects · {runtimeStatus.summary.registeredRadioMaterialCount} registered radio materials · {runtimeStatus.summary.carrierFrequencyGhz} GHz · Sionna RT {runtimeStatus.summary.sionnaVersion} · {runtimeStatus.summary.mitsubaVariant}</div>
                <div className="font-mono text-[10px] mt-1">Activated {new Date(runtimeStatus.summary.activatedAt).toLocaleString()}</div>
                    <div className="mt-2 text-emerald-100/80">Scene geometry and radio-material registration are confirmed. Place TX/RX in the 3D viewport; their current positions, orientations and RF settings are bound automatically when you run Link Analysis.</div>
              </div>
            ) : null}
            {runtimeStatus?.active && runtimeStatus.sessionId === preview.sessionId && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 flex flex-col gap-2" data-testid="indoor-auto-device-binding">
                <div className="text-sm font-semibold text-[var(--text-hi)]">Indoor TX/RX · automatic runtime binding</div>
                <p className="text-xs text-[var(--text-lo)]">Placed in this scene: {txs.filter((device) => Boolean(device.scenePosition) && device.sceneSessionId === preview.sessionId).length} TX · {rxs.filter((device) => Boolean(device.scenePosition) && device.sceneSessionId === preview.sessionId).length} RX.</p>
                <p className="text-xs text-[var(--text-lo)]">When you run Solve Link or Solve All Indoor Pairs, the app automatically applies the latest device positions, orientations, antenna arrays, carrier frequency and RF settings in the active Sionna scene. No separate synchronization button is required; the imported geometry and radio materials stay loaded.</p>
                <p className="text-[11px] text-emerald-100/80">Carrier frequency: {applicationFrequencyGhz} GHz · array spacing: 0.5λ · analysis: Link Analysis → Solve Link / Solve All Indoor Pairs.</p>
              </div>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <button type="button" onClick={() => void handleActivateScene()} disabled={activationBusy || !preview.sceneManager?.selected || !materialCatalog || !preview.materials.some((material) => material.isReferenced)} className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[var(--accent)] text-white font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed">
                {activationBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                {activationBusy ? 'Activating Sionna scene…' : !preview.sceneManager?.selected ? 'Select scene to activate' : runtimeStatus?.active && runtimeStatus.sessionId === preview.sessionId ? 'Re-activate Sionna scene' : 'Activate Sionna RT scene'}
              </button>
              <span className="text-[11px] text-[var(--text-lo)]">The active scene is held in backend memory and is cleared when another scene is selected, deleted or the backend process stops.</span>
            </div>
          </section>

          <section className="panel p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="font-semibold text-[var(--text-hi)]">Geometry inventory</h3>
                <p className="text-xs text-[var(--text-lo)]">Showing {Math.min(preview.objects.length, showAllObjects ? preview.objects.length : 30)} of {preview.objects.length} XML shape entries.</p>
              </div>
              <button type="button" onClick={() => setShowAllObjects((current) => !current)} className="text-xs px-3 py-1.5 rounded-lg border border-[var(--line)] text-[var(--text-mid)] hover:text-[var(--text-hi)]">{showAllObjects ? 'Show first 30' : 'Show all objects'}</button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
              <table className="w-full text-xs min-w-[820px]">
                <thead className="bg-[var(--ink-750)] text-[var(--text-lo)]"><tr><th className="text-left px-3 py-2">XML object</th><th className="text-left px-3 py-2">Mesh file</th><th className="text-left px-3 py-2">Material ID</th><th className="text-right px-3 py-2">Vertices</th><th className="text-right px-3 py-2">Faces</th><th className="text-left px-3 py-2">Canonical bounds</th></tr></thead>
                <tbody>{(showAllObjects ? preview.objects : preview.objects.slice(0, 30)).map((object: ImportedSceneObject) => <tr key={object.id} className="border-t border-[var(--line)]"><td className="px-3 py-2"><div className="font-mono text-[var(--text-hi)]">{object.id}</div><div className="text-[var(--text-lo)]">{object.name}</div></td><td className="px-3 py-2 font-mono text-[var(--text-mid)]">{object.fileName ?? '—'}</td><td className="px-3 py-2 font-mono text-[var(--text-mid)]">{object.materialId ?? '—'}</td><td className="px-3 py-2 text-right tabular-nums">{object.vertexCount?.toLocaleString() ?? '—'}</td><td className="px-3 py-2 text-right tabular-nums">{object.faceCount?.toLocaleString() ?? '—'}</td><td className="px-3 py-2 font-mono text-[10px] text-[var(--text-lo)]">{formatBounds(object.canonicalBounds)}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
