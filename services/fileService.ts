import { Customer, MasterPlanEntry, SpilloverEntry } from '../types';

declare const Papa: any;
declare const XLSX: any;

const HEADER_KEYWORDS = {
  id:        ['id', 'code', '編號', '客戶編號', 'store id', 'customer id', 'customerid'],
  name:      ['name', 'store', '名稱', '客戶名稱', 'store name', 'customer name', '門店名稱', '店名'],
  group:     ['group', 'assignedgroup', 'sr', 'sr name', '業務代表', '分組', '業務'],
  lat:       ['lat', 'latitude', '緯度', '座標(緯度)'],
  lng:       ['lng', 'lon', 'longitude', '經度', '座標(經度)'],
  frequency: ['freq', 'frequency', '頻次', '拜訪頻次', 'visits', '拜訪次數'],
  visitTime: ['time', 'visit time', 'duration', '拜訪時長', '停留時間'],
};

const findHeader = (headers: string[], keywords: string[]): string | null => {
  for (const header of headers) {
    const normalized = header.toLowerCase().trim().replace(/[\s_\-()\[\]]/g, '');
    for (const keyword of keywords) {
      const normalizedKw = keyword.toLowerCase().replace(/[\s_\-()\[\]]/g, '');
      if (normalized.includes(normalizedKw)) return header;
    }
  }
  return null;
};

/** Strip file extension to use as fallback group name */
const fileBaseName = (filename: string): string =>
  filename.replace(/\.[^/.]+$/, '').trim() || 'Group';

/** Build Customer array from raw row objects + header mapping + fallback group name */
const buildCustomers = (
  rawRows: Record<string, any>[],
  headers: string[],
  fallbackGroup: string,
): Customer[] => {
  const mapping = {
    id:        findHeader(headers, HEADER_KEYWORDS.id),
    name:      findHeader(headers, HEADER_KEYWORDS.name),
    group:     findHeader(headers, HEADER_KEYWORDS.group),   // optional
    lat:       findHeader(headers, HEADER_KEYWORDS.lat),
    lng:       findHeader(headers, HEADER_KEYWORDS.lng),
    frequency: findHeader(headers, HEADER_KEYWORDS.frequency),
    visitTime: findHeader(headers, HEADER_KEYWORDS.visitTime),
  };

  if (!mapping.lat || !mapping.lng || !mapping.frequency) {
    throw new Error(
      `Header Error: Missing required columns. File must include latitude, longitude, and frequency columns.\n` +
      `Detected headers: ${headers.join(', ')}`,
    );
  }

  const customers: Customer[] = rawRows
    .map((row, index) => {
      const lat       = parseFloat(row[mapping.lat!]);
      const lng       = parseFloat(row[mapping.lng!]);
      const frequency = parseInt(String(row[mapping.frequency!]), 10);
      const visitTime = parseInt(String(row[mapping.visitTime!] ?? ''), 10) || 30;
      const group     = mapping.group ? (String(row[mapping.group] ?? '').trim() || fallbackGroup) : fallbackGroup;

      if (!lat || !lng || isNaN(lat) || isNaN(lng) || isNaN(frequency)) {
        console.warn(`Skipping row ${index + 2} (missing lat/lng or frequency):`, row);
        return null;
      }
      return {
        ...row,
        id:        String(row[mapping.id!] ?? `C-${index + 1}`),
        name:      String(row[mapping.name!] ?? `Customer ${index + 1}`),
        group,
        lat,
        lng,
        frequency,
        visitTime,
      };
    })
    .filter((c): c is Customer => c !== null);

  if (customers.length === 0) {
    throw new Error('No valid rows found. Please check that latitude, longitude, and frequency columns contain numeric values.');
  }
  return customers;
};

// ── CSV parser (PapaParse) ───────────────────────────────────────────────────

const parseCSVFile = (file: File): Promise<Customer[]> =>
  new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results: any) => {
        try {
          const headers = (results.meta.fields as string[]) || [];
          resolve(buildCustomers(results.data as Record<string, any>[], headers, fileBaseName(file.name)));
        } catch (e: any) {
          reject(e);
        }
      },
      error: (err: Error) => reject(err),
    });
  });

// ── Excel parser (SheetJS / XLSX CDN) ───────────────────────────────────────

const parseExcelFile = (file: File): Promise<Customer[]> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data   = e.target?.result;
        const wb     = XLSX.read(data, { type: 'array' });
        const sheet  = wb.Sheets[wb.SheetNames[0]];
        const rawRows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        if (rawRows.length === 0) throw new Error('Excel file is empty or the first sheet has no data.');
        const headers = Object.keys(rawRows[0]);
        resolve(buildCustomers(rawRows, headers, fileBaseName(file.name)));
      } catch (e: any) {
        reject(e);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });

// ── Public API ───────────────────────────────────────────────────────────────

/** Parse CSV or Excel (.xlsx / .xls) file into Customer array */
export const parseFile = (file: File): Promise<Customer[]> => {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'csv') return parseCSVFile(file);
  if (ext === 'xlsx' || ext === 'xls') return parseExcelFile(file);
  return Promise.reject(new Error(`Unsupported file type ".${ext}". Please upload a CSV or Excel (.xlsx / .xls) file.`));
};

/** @deprecated use parseFile instead */
export const parseCSV = parseFile;

// ── Export helpers ───────────────────────────────────────────────────────────

export const exportToExcel = (plan: MasterPlanEntry[], groupName: string) => {
  if (!plan?.length) { alert('No master plan data to export.'); return; }
  const exportData = plan.map(v => ({
    'Group (SR)':            v.assigned_group,
    'Visit_Date':            v.Visit_Date,
    'Visit_Day':             v.Visit_Day,
    'Zone_ID':               v.Zone_ID,
    'Visit_Sequence':        v.Visit_Sequence,
    'Distance_from_Prev_km': v.Distance_from_Prev_km,
    'Est_Drive_Time_mins':   v.Est_Drive_Time_mins,
    'CustomerId':            v.CustomerId,
    'CustomerName':          v.CustomerName,
    'Frequency':             v.Frequency,
    'Latitude':              v.Latitude,
    'Longitude':             v.Longitude,
  }));
  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `SR Plan - ${groupName}`);
  XLSX.writeFile(wb, `SR_Monthly_Plan_${groupName}.xlsx`);
};

export const exportSpilloverToExcel = (plan: SpilloverEntry[], groupName: string) => {
  if (!plan?.length) { alert('No spillover customer data to export.'); return; }
  const ws = XLSX.utils.json_to_sheet(plan);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Spillover List - ${groupName}`);
  XLSX.writeFile(wb, `SR_Spillover_${groupName}.xlsx`);
};
