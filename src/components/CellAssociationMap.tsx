/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Canvas-rendered 2D cell-to-transmitter association view. This is a display
 * layer over the existing RadioMapSolver outputs; it never starts a solve.
 */
import React, { useEffect, useRef } from 'react';
import { RadioMapGrid, Transmitter } from '../types';
import { getSectorColorCss } from '../utils';

export type AssociationLayer = 'rss' | 'sinr' | 'path_gain' | 'interferer';

interface CellAssociationMapProps {
  radioMap: RadioMapGrid;
  txs: Transmitter[];
  layer: AssociationLayer;
  selectedCellIndex: number | null;
  onSelectCell: (cellIndex: number) => void;
}

interface CanvasTransform {
  x0: number;
  y0: number;
  scale: number;
  width: number;
  height: number;
}

function associationForLayer(cell: RadioMapGrid['cells'][number], layer: AssociationLayer): number | null | undefined {
  switch (layer) {
    case 'rss': return cell.servingTx;
    case 'sinr': return cell.bestSinrTx;
    case 'path_gain': return cell.bestPathGainTx;
    case 'interferer': return cell.topInterfererTx;
  }
}

export function CellAssociationMap({
  radioMap, txs, layer, selectedCellIndex, onSelectCell,
}: CellAssociationMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef<CanvasTransform | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const render = () => {
      const cssWidth = Math.max(280, parent.clientWidth);
      const cssHeight = 310;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      const pad = { left: 42, right: 16, top: 16, bottom: 34 };
      const innerWidth = Math.max(1, cssWidth - pad.left - pad.right);
      const innerHeight = Math.max(1, cssHeight - pad.top - pad.bottom);
      const spanX = Math.max(radioMap.maxX - radioMap.minX, radioMap.gridSize);
      const spanY = Math.max(radioMap.maxY - radioMap.minY, radioMap.gridSize);
      const scale = Math.min(innerWidth / spanX, innerHeight / spanY);
      const mapWidth = spanX * scale;
      const mapHeight = spanY * scale;
      const x0 = pad.left + (innerWidth - mapWidth) / 2;
      const y0 = pad.top + (innerHeight - mapHeight) / 2;
      transformRef.current = { x0, y0, scale, width: cssWidth, height: cssHeight };

      // Subtle coordinate grid and axes.
      ctx.strokeStyle = '#e7e5e4';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      for (let i = 0; i <= 4; i += 1) {
        const gx = x0 + (mapWidth * i) / 4;
        const gy = y0 + (mapHeight * i) / 4;
        ctx.beginPath(); ctx.moveTo(gx, y0); ctx.lineTo(gx, y0 + mapHeight); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x0 + mapWidth, gy); ctx.stroke();
      }
      ctx.setLineDash([]);

      const cellPx = Math.max(1.6, Math.min(18, radioMap.gridSize * scale * 0.96));
      const selected = selectedCellIndex == null ? null : radioMap.cells[selectedCellIndex];
      const txIdByIndex = new Map((radioMap.txStats ?? []).map((stat) => [stat.txIndex, stat.txId]));
      radioMap.cells.forEach((cell, index) => {
        const txIndex = associationForLayer(cell, layer);
        const px = x0 + (cell.x - radioMap.minX) * scale;
        const py = y0 + mapHeight - (cell.y - radioMap.minY) * scale;
        const txId = txIndex == null || txIndex < 0 ? undefined : txIdByIndex.get(txIndex);
        ctx.fillStyle = txIndex == null || txIndex < 0 ? '#a8a29e' : getSectorColorCss(txIndex, txId);
        ctx.fillRect(px - cellPx / 2, py - cellPx / 2, cellPx, cellPx);
        if (index === selectedCellIndex) {
          ctx.strokeStyle = '#111827';
          ctx.lineWidth = 2.5;
          ctx.strokeRect(px - cellPx / 2 - 2, py - cellPx / 2 - 2, cellPx + 4, cellPx + 4);
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(px - cellPx / 2 - 4, py - cellPx / 2 - 4, cellPx + 8, cellPx + 8);
        }
      });

      // Draw actual TX centers on top of the association cells.
      (radioMap.txStats ?? []).forEach((stats) => {
        const tx = txs.find((candidate) => candidate.id === stats.txId);
        if (!tx) return;
        const txIndex = stats.txIndex;
        const px = x0 + (tx.enu.x - radioMap.minX) * scale;
        const py = y0 + mapHeight - (tx.enu.y - radioMap.minY) * scale;
        if (!Number.isFinite(px) || !Number.isFinite(py) || px < x0 - 20 || px > x0 + mapWidth + 20 || py < y0 - 20 || py > y0 + mapHeight + 20) return;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(px - 7, py); ctx.lineTo(px + 7, py); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px, py - 7); ctx.lineTo(px, py + 7); ctx.stroke();
        ctx.strokeStyle = getSectorColorCss(txIndex, stats.txId);
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(px - 7, py); ctx.lineTo(px + 7, py); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px, py - 7); ctx.lineTo(px, py + 7); ctx.stroke();
        const label = `TX${txIndex + 1}`;
        ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.strokeText(label, px + 9, py - 8);
        ctx.fillStyle = '#1f2937';
        ctx.fillText(label, px + 9, py - 8);
      });

      ctx.fillStyle = '#475569';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`East · ${radioMap.minX.toFixed(0)} to ${radioMap.maxX.toFixed(0)} m`, cssWidth / 2, cssHeight - 8);
      ctx.save();
      ctx.translate(12, cssHeight / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`North · ${radioMap.minY.toFixed(0)} to ${radioMap.maxY.toFixed(0)} m`, 0, 0);
      ctx.restore();
      if (selected) {
        ctx.textAlign = 'right';
        ctx.fillStyle = '#92400e';
        ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(`Selected cell #${selectedCellIndex}`, cssWidth - 12, 14);
      }
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [radioMap, txs, layer, selectedCellIndex]);

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const transform = transformRef.current;
    if (!canvas || !transform) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    const { x0, y0, scale } = transform;
    const cellSize = Math.max(1.6, Math.min(18, radioMap.gridSize * scale * 0.96));
    let bestIndex = -1;
    let bestDistance = Infinity;
    radioMap.cells.forEach((cell, index) => {
      const px = x0 + (cell.x - radioMap.minX) * scale;
      const py = y0 + (radioMap.maxY - cell.y) * scale;
      const distance = (px - clickX) ** 2 + (py - clickY) ** 2;
      if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
    });
    if (bestIndex >= 0 && bestDistance <= Math.max(14, cellSize * 1.5) ** 2) onSelectCell(bestIndex);
  };

  const layerLabel: Record<AssociationLayer, string> = {
    rss: 'RSS serving sector',
    sinr: 'Best SINR sector',
    path_gain: 'Best path-gain sector',
    interferer: 'Dominant interferer',
  };
  const counts = new Map<number, number>();
  radioMap.cells.forEach((cell) => {
    const index = associationForLayer(cell, layer);
    if (index != null && index >= 0) counts.set(index, (counts.get(index) ?? 0) + 1);
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold text-slate-600">{layerLabel[layer]} · top view</span>
        <span className="text-[9px] text-slate-400">Click a cell to mark it in 3D</span>
      </div>
      <div className="overflow-hidden rounded border border-[#e3e0d6] bg-white">
        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          role="button"
          tabIndex={0}
          aria-label={`Interactive ${layerLabel[layer]} association map. Click a cell to select it.`}
          className="block w-full cursor-crosshair"
        />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {radioMap.txStats?.map((stat) => (
          <div key={stat.txIndex} className="flex items-center gap-1.5 text-[9px] text-slate-600">
            <span className="inline-block h-2.5 w-2.5 rounded-sm border border-black/10" style={{ background: getSectorColorCss(stat.txIndex, stat.txId) }} />
            <span>{stat.txName}</span>
            <b className="font-mono">{counts.get(stat.txIndex) ?? 0}</b>
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-[9px] text-slate-500">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-stone-400" />
          Unassociated
        </div>
      </div>
      <p className="text-[9px] leading-relaxed text-slate-500">Colours use the same deterministic TX-index palette as the 3D categorical radio-map. This is an association diagram, not a continuous RSS/SINR heatmap.</p>
    </div>
  );
}
