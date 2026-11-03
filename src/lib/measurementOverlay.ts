/**
 * Build georeferenced 3D overlays from the original field-measurement rows.
 *
 * - Unique locations: exact radio identity profile + valid RF/GPS/timestamp,
 *   grouped by WGS84 coordinate and summarized with median RSRP/SINR.
 * - Individual profile records: one marker for every eligible row in that
 *   exact radio identity profile. Coincident markers retain the exact same
 *   geographic coordinates and are inspected together on hover.
 * - All imported records: one marker per row with valid GPS, optionally
 *   filtered by RAT, PCI, and RF validity. Invalid-RSRP rows remain visible
 *   in neutral gray when the validity filter is set to All.
 */
import { MeasurementOverlayPoint, MeasurementOverlaySample } from '../types';

export interface MeasurementOverlayProfile {
  rat: string;
  pci: number;
  band: number | null;
  arfcn: number | null;
  lteAnchorCellId: string | null;
  lteAnchorPci: number | null;
  lteAnchorEarfcn: number | null;
}

export interface MeasurementOverlaySourceRow {
  rowIndex: number;
  quality: {
    timestampUtc?: string | null;
    rat?: string | null;
    pci?: number | null;
    band?: number | null;
    arfcn?: number | null;
    rsrpDbm: number | null;
    rsrqDb?: number | null;
    sinrDb: number | null;
    rssiDbm?: number | null;
    lat: number | null;
    lon: number | null;
    radioValid?: boolean;
    locationValid?: boolean;
    eligibleForSpatialValidation: boolean;
    qualityFlags?: string[];
  };
  raw: Record<string, string>;
}

export interface AllRecordsOverlayFilters {
  rat?: string;
  pci?: number | null;
  validOnly?: boolean;
}

function rawValue(raw: Record<string, string>, ...keys: string[]): string {
  const lookup = new Map(Object.entries(raw).map(([key, value]) => [key.trim().toLowerCase(), value]));
  for (const key of keys) {
    const value = lookup.get(key.toLowerCase());
    if (value != null && value.trim() !== '') return value.trim();
  }
  return '';
}

function rawNumber(raw: Record<string, string>, ...keys: string[]): number | null {
  const value = rawValue(raw, ...keys);
  if (!value) return null;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sameOptionalNumber(actual: number | null, expected: number | null): boolean {
  return actual === expected;
}

function matchesProfile(row: MeasurementOverlaySourceRow, profile: MeasurementOverlayProfile): boolean {
  const rat = (row.quality.rat ?? rawValue(row.raw, 'rat', 'radio_access_technology', 'technology')).toUpperCase();
  const pci = row.quality.pci ?? rawNumber(row.raw, 'pci', 'physical_cell_id');
  const band = row.quality.band ?? rawNumber(row.raw, 'band', 'nr_band', 'lte_band');
  const arfcn = row.quality.arfcn ?? rawNumber(row.raw, 'arfcn', 'nrarfcn', 'nr_arfcn');
  const anchorCellId = rawValue(row.raw, 'cell_id', 'cellid', 'eci', 'ecgi').toUpperCase() || null;
  const anchorPci = rawNumber(row.raw, 'anchor_pci', 'lte_anchor_pci');
  const anchorEarfcn = rawNumber(row.raw, 'earfcn', 'anchor_earfcn');

  return rat === profile.rat.toUpperCase() && pci === profile.pci
    && sameOptionalNumber(band, profile.band) && sameOptionalNumber(arfcn, profile.arfcn)
    && anchorCellId === (profile.lteAnchorCellId?.toUpperCase() ?? null)
    && sameOptionalNumber(anchorPci, profile.lteAnchorPci)
    && sameOptionalNumber(anchorEarfcn, profile.lteAnchorEarfcn);
}

function toSample(row: MeasurementOverlaySourceRow): MeasurementOverlaySample {
  const q = row.quality;
  const rat = q.rat ?? (rawValue(row.raw, 'rat', 'radio_access_technology', 'technology') || 'Unknown');
  const pci = q.pci ?? rawNumber(row.raw, 'pci', 'physical_cell_id');
  return {
    rowIndex: row.rowIndex,
    timestampUtc: q.timestampUtc ?? (rawValue(row.raw, 'timestamp_utc', 'utc_timestamp', 'timestamp', 'datetime', 'time') || null),
    rat,
    pci,
    band: q.band ?? rawNumber(row.raw, 'band', 'nr_band', 'lte_band'),
    arfcn: q.arfcn ?? rawNumber(row.raw, 'arfcn', 'nrarfcn', 'nr_arfcn'),
    rsrpDbm: q.rsrpDbm,
    rsrqDb: q.rsrqDb ?? null,
    sinrDb: q.sinrDb,
    rssiDbm: q.rssiDbm ?? null,
    radioValid: q.radioValid ?? q.rsrpDbm != null,
    locationValid: q.locationValid ?? (q.lat != null && q.lon != null),
    qualityFlags: q.qualityFlags ?? [],
  };
}

function makeIndividualPoint(row: MeasurementOverlaySourceRow): MeasurementOverlayPoint {
  const sample = toSample(row);
  return {
    id: `row-${row.rowIndex}`,
    latitude: row.quality.lat!,
    longitude: row.quality.lon!,
    rsrpDbm: sample.rsrpDbm,
    sinrDb: sample.sinrDb,
    sampleCount: 1,
    pci: sample.pci,
    rat: sample.rat,
    samples: [sample],
  };
}

/** Build the selected radio identity as either unique locations (default) or
 * one marker per measurement record. The default preserves the grouped 3D measurement overlay's
 * 439-location behaviour for the current 446-row selected profile. */
export function buildMeasurementOverlayPoints(
  rows: MeasurementOverlaySourceRow[],
  profile: MeasurementOverlayProfile,
  mode: 'unique' | 'individual' = 'unique',
): MeasurementOverlayPoint[] {
  const selectedRows = rows.filter((row) => row.quality.eligibleForSpatialValidation
    && row.quality.lat != null && row.quality.lon != null && row.quality.rsrpDbm != null
    && matchesProfile(row, profile));

  if (mode === 'individual') {
    return selectedRows.map(makeIndividualPoint)
      .sort((a, b) => (a.samples[0].timestampUtc ?? '').localeCompare(b.samples[0].timestampUtc ?? '') || a.id.localeCompare(b.id));
  }

  const groups = new Map<string, MeasurementOverlaySourceRow[]>();
  for (const row of selectedRows) {
    const key = `${row.quality.lat!.toFixed(7)}|${row.quality.lon!.toFixed(7)}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, group]) => {
    const samples = group.map(toSample).sort((a, b) => (a.timestampUtc ?? '').localeCompare(b.timestampUtc ?? '') || a.rowIndex - b.rowIndex);
    const rsrp = samples.map((sample) => sample.rsrpDbm).filter((value): value is number => value != null);
    const sinr = samples.map((sample) => sample.sinrDb).filter((value): value is number => value != null);
    return {
      id: key,
      latitude: group[0].quality.lat!,
      longitude: group[0].quality.lon!,
      rsrpDbm: median(rsrp),
      sinrDb: median(sinr),
      sampleCount: samples.length,
      pci: profile.pci,
      rat: profile.rat,
      samples,
    };
  }).sort((a, b) => a.latitude - b.latitude || a.longitude - b.longitude);
}

/** Build one marker per original source row for the complete imported dataset.
 * GPS is mandatory for spatial display; radio-invalid rows can be included and
 * appear gray so they are not silently discarded from the 3D record view. */
export function buildAllMeasurementOverlayPoints(
  rows: MeasurementOverlaySourceRow[],
  filters: AllRecordsOverlayFilters = {},
): MeasurementOverlayPoint[] {
  return rows.filter((row) => {
    const q = row.quality;
    if (q.lat == null || q.lon == null) return false;
    const sample = toSample(row);
    if (filters.rat && sample.rat.toUpperCase() !== filters.rat.toUpperCase()) return false;
    if (filters.pci != null && sample.pci !== filters.pci) return false;
    if (filters.validOnly && !sample.radioValid) return false;
    return true;
  }).map(makeIndividualPoint)
    .sort((a, b) => (a.samples[0].timestampUtc ?? '').localeCompare(b.samples[0].timestampUtc ?? '') || a.id.localeCompare(b.id));
}
