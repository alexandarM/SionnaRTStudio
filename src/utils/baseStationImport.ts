import { GeoAnchor, ENUVector, Transmitter } from '../types';
import { latLonToENU } from '../utils';

export const ALL_BASE_STATION_BANDS = '__all__';

export interface BaseStationDraft {
  rowNumber: number;
  site: string;
  transmitter: string;
  antenna: string;
  latitude: number;
  longitude: number;
  heightM: number;
  azimuthDeg: number;
  mechanicalDowntiltDeg: number;
  electricalDowntiltDeg: number;
  powerDbm: number;
  frequencyBand: string;
  carrierFrequencyGhz?: number;
  antennaGainDbi?: number;
}

export interface BaseStationImportOptions {
  heightReference: 'agl' | 'roof' | 'scene_z';
  powerColumnMeaning: 'conducted' | 'eirp';
  defaultAntennaGainDbi?: number;
  defaultArraySize?: [number, number];
}

export interface BaseStationImportResult {
  transmitters: Transmitter[];
  skippedRows: number[];
  warnings: string[];
}

const normaliseHeader = (value: string): string => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

function parseDelimited(text: string): string[][] {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t'];
  const delimiter = candidates
    .map((candidate) => ({ candidate, count: firstLine.split(candidate).length - 1 }))
    .sort((a, b) => b.count - a.count)[0]?.candidate ?? ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === delimiter && !quoted) {
      row.push(field.trim());
      field = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field.trim());
      field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field.trim());
  if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}

function columnIndex(headers: string[], aliases: string[], prefixAliases: string[] = []): number {
  const normalised = headers.map(normaliseHeader);
  for (const alias of aliases) {
    const idx = normalised.indexOf(normaliseHeader(alias));
    if (idx >= 0) return idx;
  }
  for (const prefix of prefixAliases) {
    const needle = normaliseHeader(prefix);
    const idx = normalised.findIndex((name) => name.startsWith(needle));
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const cleaned = value.trim().replace(/\s/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function cellValue(row: string[], index: number): string {
  return index >= 0 ? String(row[index] ?? '').trim() : '';
}

function exactCarrierFrequencyGhz(value: string, header: string): number | undefined {
  // Only explicit carrier/center/DL-frequency columns are accepted. Never infer
  // a carrier from labels such as "Band 20 (791MHz)": 791 MHz is an operating
  // band edge, not necessarily the deployed channel centre.
  const text = value.trim().toLowerCase().replace(',', '.');
  if (!text) return undefined;
  const explicit = text.match(/(\d+(?:\.\d+)?)\s*(ghz|mhz)\b/);
  const numeric = explicit ? Number(explicit[1]) : Number(text.replace(/\s/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const headerLower = header.toLowerCase();
  const headerUnit = headerLower.includes('mhz') ? 'mhz' : headerLower.includes('ghz') ? 'ghz' : undefined;
  const unit = explicit?.[2] ?? headerUnit;
  // An unqualified numeric field is ambiguous; require either a unit in the
  // cell or in its column heading instead of guessing GHz/MHz.
  if (!unit) return undefined;
  return unit === 'mhz' ? numeric / 1000 : numeric;
}

export function rowsToBaseStationDrafts(rows: string[][]): BaseStationDraft[] {
  if (rows.length < 2) throw new Error('The table must contain a header and at least one base-station row.');
  const headers = rows[0];
  const cols = {
    site: columnIndex(headers, ['Site', 'Site Name', 'Location', 'Site ID', 'Sajt']),
    transmitter: columnIndex(headers, ['Transmitter', 'Transmitter Name', 'Sector', 'Sector Name', 'Cell Name', 'Name']),
    antenna: columnIndex(headers, ['Antenna', 'Antenna Model', 'Antenna Type', 'Model']),
    longitude: columnIndex(headers, ['Longitude', 'Lon', 'Long', 'Lng']),
    latitude: columnIndex(headers, ['Latitude', 'Lat']),
    height: columnIndex(headers, ['Height (m)', 'Height m', 'Antenna Height (m)', 'Antenna Height', 'Height']),
    azimuth: columnIndex(headers, ['Azimuth (°)', 'Azimuth (deg)', 'Azimuth', 'Bearing']),
    mechanicalDowntilt: columnIndex(
      headers,
      ['Mechanical Downtilt (°)', 'Mechanical Downtilt', 'Mechanical Tilt (°)', 'Mechanical Tilt', 'Mech Downtilt', 'M-Tilt'],
      ['mechanical d', 'mechanical t', 'mech down'],
    ),
    electricalDowntilt: columnIndex(headers, ['Electrical Downtilt (°)', 'Electrical Downtilt', 'Electrical Tilt (°)', 'Electrical Tilt', 'E-Tilt']),
    power: columnIndex(headers, ['Power (dBm)', 'Power dBm', 'TX Power (dBm)', 'Transmit Power (dBm)', 'Power']),
    frequencyBand: columnIndex(headers, ['Frequency Band', 'Band', 'NR Band']),
    carrierFrequencyGhz: columnIndex(headers, [
      'Carrier Frequency (GHz)', 'Carrier Frequency (MHz)', 'Carrier Frequency',
      'Center Frequency (GHz)', 'Center Frequency (MHz)', 'Center Frequency',
      'Downlink Frequency (GHz)', 'Downlink Frequency (MHz)', 'Downlink Frequency',
      'DL Frequency (GHz)', 'DL Frequency (MHz)', 'DL Frequency',
      'Frequency (GHz)', 'Frequency (MHz)',
    ]),
    antennaGainDbi: columnIndex(headers, ['Antenna Gain (dBi)', 'Gain dBi', 'Antenna Gain']),
  };
  const required = ['site', 'longitude', 'latitude', 'height', 'azimuth', 'power', 'frequencyBand'] as const;
  const missing = required.filter((key) => cols[key] < 0);
  if (missing.length) throw new Error(`Required columns are missing: ${missing.join(', ')}. Columns found: ${headers.join(' | ')}`);

  const drafts: BaseStationDraft[] = [];
  const rowErrors: string[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.every((cell) => String(cell ?? '').trim() === '')) continue;
    const rowNumber = index + 1;
    const latitude = parseNumber(cellValue(row, cols.latitude));
    const longitude = parseNumber(cellValue(row, cols.longitude));
    const heightM = parseNumber(cellValue(row, cols.height));
    const azimuthDeg = parseNumber(cellValue(row, cols.azimuth));
    const powerDbm = parseNumber(cellValue(row, cols.power));
    const mechanicalDowntiltRaw = cols.mechanicalDowntilt >= 0
      ? parseNumber(cellValue(row, cols.mechanicalDowntilt)) : undefined;
    const mechanicalDowntiltDeg = mechanicalDowntiltRaw ?? 0;
    const electricalDowntiltDeg = cols.electricalDowntilt >= 0
      ? parseNumber(cellValue(row, cols.electricalDowntilt)) ?? 0 : 0;
    const frequencyBand = cellValue(row, cols.frequencyBand);
    const carrierFrequencyGhz = cols.carrierFrequencyGhz >= 0
      ? exactCarrierFrequencyGhz(cellValue(row, cols.carrierFrequencyGhz), headers[cols.carrierFrequencyGhz] ?? '')
      : undefined;
    const antennaGainDbi = cols.antennaGainDbi >= 0
      ? parseNumber(cellValue(row, cols.antennaGainDbi)) : undefined;

    const errors: string[] = [];
    if (!cellValue(row, cols.site)) errors.push('site');
    if (!frequencyBand) errors.push('frequency band');
    if (cols.mechanicalDowntilt >= 0 && mechanicalDowntiltRaw == null) errors.push('mechanical downtilt');
    if (Math.abs(mechanicalDowntiltDeg + electricalDowntiltDeg) > 90) errors.push('combined downtilt');
    if (latitude == null || latitude < -90 || latitude > 90) errors.push('latitude');
    if (longitude == null || longitude < -180 || longitude > 180) errors.push('longitude');
    if (heightM == null || heightM < 0 || heightM > 1000) errors.push('height');
    if (azimuthDeg == null || azimuthDeg < -360 || azimuthDeg > 720) errors.push('azimuth');
    if (powerDbm == null || powerDbm < -30 || powerDbm > 100) errors.push('power');
    if (carrierFrequencyGhz != null && (carrierFrequencyGhz <= 0 || carrierFrequencyGhz > 300)) errors.push('carrier frequency');
    if (errors.length) {
      rowErrors.push(`Row ${rowNumber}: invalid value for ${errors.join(', ')}`);
      continue;
    }

    drafts.push({
      rowNumber,
      site: cellValue(row, cols.site),
      transmitter: cellValue(row, cols.transmitter),
      antenna: cellValue(row, cols.antenna),
      latitude: latitude!, longitude: longitude!, heightM: heightM!,
      azimuthDeg: ((azimuthDeg! % 360) + 360) % 360,
      mechanicalDowntiltDeg, electricalDowntiltDeg,
      powerDbm: powerDbm!,
      frequencyBand,
      carrierFrequencyGhz,
      antennaGainDbi,
    });
  }
  if (rowErrors.length) {
    const details = rowErrors.slice(0, 20).join('\n');
    const suffix = rowErrors.length > 20 ? `\n… and ${rowErrors.length - 20} more invalid rows.` : '';
    throw new Error(`The table was not imported because ${rowErrors.length} rows contain invalid or missing required values:\n${details}${suffix}`);
  }
  if (!drafts.length) throw new Error('No valid base-station rows were found.');
  return drafts;
}

// Minimal OOXML reader for XLSX files. It uses the browser's native ZIP/DEFLATE
// APIs, so no extra runtime dependency or change to the Colab setup is needed.
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = globalThis.DecompressionStream;
  if (!DS) throw new Error('This browser does not support XLSX decompression. Save the spreadsheet as UTF-8 CSV and try again.');
  const copy = data.slice().buffer;
  const stream = new Blob([copy]).stream().pipeThrough(new DS('deflate-raw' as CompressionFormat));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(bytes: Uint8Array, path: string): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The XLSX archive has an invalid ZIP central directory.');
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  let localOffset = -1;
  let compression = -1;
  let compressedSize = 0;
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid XLSX ZIP entry.');
    const method = view.getUint16(cursor + 10, true);
    const size = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLen));
    if (name === path) {
      compression = method;
      compressedSize = size;
      localOffset = view.getUint32(cursor + 42, true);
      break;
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (localOffset < 0) throw new Error(`The XLSX file does not contain ${path}.`);
  const localNameLen = view.getUint16(localOffset + 26, true);
  const localExtraLen = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + localNameLen + localExtraLen;
  const compressed = bytes.slice(dataStart, dataStart + compressedSize);
  if (compression === 0) return compressed;
  if (compression === 8) return inflateRaw(compressed);
  throw new Error(`The XLSX file uses an unsupported ZIP compression method: ${compression}.`);
}

function xmlDocument(bytes: Uint8Array): XMLDocument {
  const xml = new TextDecoder().decode(bytes);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The XLSX file contains invalid XML.');
  return doc;
}

function descendants(node: ParentNode, localName: string): Element[] {
  return Array.from(node.querySelectorAll('*')).filter((element) => element.localName === localName);
}

function columnNumber(cellRef: string): number {
  const letters = cellRef.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return Math.max(0, n - 1);
}

async function parseXlsxRows(buffer: ArrayBuffer): Promise<string[][]> {
  const bytes = new Uint8Array(buffer);
  const workbook = xmlDocument(await readZipEntry(bytes, 'xl/workbook.xml'));
  const firstSheet = descendants(workbook, 'sheet')[0];
  const relationshipId = firstSheet?.getAttribute('r:id')
    ?? firstSheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  try {
    const rels = xmlDocument(await readZipEntry(bytes, 'xl/_rels/workbook.xml.rels'));
    const relation = descendants(rels, 'Relationship').find((el) => el.getAttribute('Id') === relationshipId);
    const target = relation?.getAttribute('Target');
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  } catch { /* Excel files with a single standard worksheet use sheet1.xml. */ }

  let sharedStrings: string[] = [];
  try {
    const shared = xmlDocument(await readZipEntry(bytes, 'xl/sharedStrings.xml'));
    sharedStrings = descendants(shared, 'si').map((si) => descendants(si, 't').map((t) => t.textContent ?? '').join(''));
  } catch { /* inline strings do not need sharedStrings.xml */ }

  const sheet = xmlDocument(await readZipEntry(bytes, sheetPath));
  const rows: string[][] = [];
  for (const rowEl of descendants(sheet, 'row')) {
    const cells: string[] = [];
    for (const cellEl of descendants(rowEl, 'c')) {
      const col = columnNumber(cellEl.getAttribute('r') ?? 'A1');
      const type = cellEl.getAttribute('t');
      let value = '';
      if (type === 'inlineStr') value = descendants(cellEl, 't').map((t) => t.textContent ?? '').join('');
      else {
        const raw = descendants(cellEl, 'v')[0]?.textContent ?? '';
        value = type === 's' ? (sharedStrings[Number(raw)] ?? '') : raw;
      }
      cells[col] = value;
    }
    rows.push(cells.map((v) => v ?? ''));
  }
  return rows;
}

export async function parseBaseStationFile(file: File): Promise<BaseStationDraft[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    return rowsToBaseStationDrafts(parseDelimited(await file.text()));
  }
  if (lower.endsWith('.xlsx')) return rowsToBaseStationDrafts(await parseXlsxRows(await file.arrayBuffer()));
  throw new Error('Supported formats are .xlsx, .csv, .tsv, and .txt.');
}

/**
 * Select one exact Frequency Band group or retain every antenna row.
 * The raw band label is preserved: different labels are never silently merged.
 */
export function filterBaseStationDraftsByBand(
  drafts: BaseStationDraft[],
  selectedBand: string,
): BaseStationDraft[] {
  if (selectedBand === ALL_BASE_STATION_BANDS) return drafts;
  return drafts.filter((row) => row.frequencyBand === selectedBand);
}

export function baseStationDraftsToTransmitters(
  drafts: BaseStationDraft[],
  anchor: GeoAnchor,
  options: BaseStationImportOptions,
): BaseStationImportResult {
  const warnings: string[] = [];
  const skippedRows: number[] = [];
  const usedIds = new Set<string>();
  const slug = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 36) || 'site';
  const arraySize = options.defaultArraySize ?? [1, 1];

  const transmitters = drafts.flatMap((row) => {
    const site = row.site || 'Site';
    const label = row.transmitter || row.antenna || `Sector ${row.rowNumber - 1}`;
    let id = `bs_${slug(site)}_${slug(label)}_${row.rowNumber}`;
    if (usedIds.has(id)) id = `${id}_${usedIds.size + 1}`;
    usedIds.add(id);

    let conductedPowerDbm = row.powerDbm;
    let appliedAntennaGainDbi: number | undefined;
    if (options.powerColumnMeaning === 'eirp') {
      const gain = row.antennaGainDbi ?? options.defaultAntennaGainDbi;
      if (gain == null || !Number.isFinite(gain)) {
        skippedRows.push(row.rowNumber);
        warnings.push(`Row ${row.rowNumber}: the power column is marked as EIRP, but antenna gain [dBi] is missing; the row was not imported.`);
        return [];
      }
      conductedPowerDbm = row.powerDbm - gain;
      appliedAntennaGainDbi = gain;
    }

    const enu: ENUVector = latLonToENU(row.latitude, row.longitude, anchor);
    const totalDownTilt = row.mechanicalDowntiltDeg + row.electricalDowntiltDeg;
    const transmitter: Transmitter = {
      id,
      name: `${site} · ${label}`,
      site,
      transmitterLabel: label,
      antennaModel: row.antenna || undefined,
      frequencyBand: row.frequencyBand || undefined,
      carrierFrequencyGhz: row.carrierFrequencyGhz,
      sourcePowerDbm: row.powerDbm,
      antennaGainDbi: appliedAntennaGainDbi ?? row.antennaGainDbi,
      latitude: row.latitude,
      longitude: row.longitude,
      height: row.heightM,
      heightReference: options.heightReference,
      powerDbm: conductedPowerDbm,
      powerReference: options.powerColumnMeaning,
      antennaArraySize: arraySize,
      beamsteeringAzimuth: row.azimuthDeg,
      // Positive mechanical/electrical downtilt means a negative elevation.
      beamsteeringElevation: -totalDownTilt,
      mechanicalDowntiltDeg: row.mechanicalDowntiltDeg,
      electricalDowntiltDeg: row.electricalDowntiltDeg,
      enu,
    };
    return [transmitter];
  });

  const bands = Array.from(new Set(transmitters.map((tx) => tx.frequencyBand).filter(Boolean)));
  const frequencies = Array.from(new Set(transmitters.map((tx) => tx.carrierFrequencyGhz).filter((v): v is number => Number.isFinite(v))));
  if (bands.length > 1) warnings.push(`Imported ${bands.length} frequency-band groups (${bands.join(', ')}). RadioMapSolver requires one carrier frequency per solve; select a band in the Coverage panel.`);
  if (frequencies.length > 1) warnings.push(`The imported rows contain ${frequencies.length} different carrier frequencies (${frequencies.join(', ')} GHz); calculate them separately.`);
  if (transmitters.some((tx) => !tx.carrierFrequencyGhz)) {
    warnings.push('No exact DL carrier frequency was found in the table. Labels such as n78, GSM 900, or E-UTRA Band 20 (791 MHz) are retained as metadata and are NOT treated as an assumed channel center. Enter the deployed frequency in RF Controls before calculating a radio map.');
  }
  if (transmitters.some((tx) => tx.antennaModel)) {
    warnings.push('The antenna name is retained as metadata. The current Sionna RT scene model uses the global TX pattern/array configuration; the model name alone does not load a manufacturer-specific radiation pattern.');
  }
  return { transmitters, skippedRows, warnings };
}
