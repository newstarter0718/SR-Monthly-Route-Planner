
import { Customer, MasterPlanEntry, SpilloverEntry } from '../types';

declare const Papa: any;
declare const XLSX: any;

const HEADER_KEYWORDS = {
  id: ['id', 'code', '編號', '客戶編號', 'store id', 'customer id', 'customerid'],
  name: ['name', 'store', '名稱', '客戶名稱', 'store name', 'customer name'],
  group: ['group', 'assignedgroup', 'sr', 'sr name', '業務代表', '分組'],
  lat: ['lat', 'latitude', '緯度'],
  lng: ['lng', 'lon', 'longitude', '經度'],
  frequency: ['freq', 'frequency', '頻次', '拜訪頻次', 'visits'],
  visitTime: ['time', 'visit time', 'duration', '拜訪時長', '停留時間'],
};

const findHeader = (headers: string[], keywords: string[]): string | null => {
  for (const header of headers) {
    const lowerHeader = header.toLowerCase().trim().replace(/[\s_-]/g, '');
    for (const keyword of keywords) {
      if (lowerHeader.includes(keyword)) {
        return header;
      }
    }
  }
  return null;
};

export const parseCSV = (file: File): Promise<Customer[]> => {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results: any) => {
        const headers = (results.meta.fields as string[]) || [];
        const mapping: Record<string, string | null> = {
          id: findHeader(headers, HEADER_KEYWORDS.id),
          name: findHeader(headers, HEADER_KEYWORDS.name),
          group: findHeader(headers, HEADER_KEYWORDS.group),
          lat: findHeader(headers, HEADER_KEYWORDS.lat),
          lng: findHeader(headers, HEADER_KEYWORDS.lng),
          frequency: findHeader(headers, HEADER_KEYWORDS.frequency),
          visitTime: findHeader(headers, HEADER_KEYWORDS.visitTime),
        };
        if (!mapping.group) {
          reject(new Error(`CSV Header Error: Could not find a 'Group' column (e.g., 'group', 'sr name').`));
          return;
        }
        if (!mapping.lat || !mapping.lng || !mapping.frequency) {
          reject(new Error(`CSV Header Error: Missing core columns. Please ensure the file includes headers for 'latitude', 'longitude', and 'frequency'.`));
          return;
        }
        const customers: Customer[] = (results.data as any[])
          .map((row: any, index: number) => {
            const lat = parseFloat(row[mapping.lat!]);
            const lng = parseFloat(row[mapping.lng!]);
            const frequency = parseInt(row[mapping.frequency!], 10);
            const visitTime = parseInt(row[mapping.visitTime!], 10) || 30;
            const group = row[mapping.group!];
            if (!lat || !lng || isNaN(lat) || isNaN(lng) || isNaN(frequency) || !group) {
              console.warn(`Skipping invalid row ${index + 2} (missing lat/lng, frequency, or group):`, row);
              return null;
            }
            return {
              ...row,
              id: row[mapping.id!] || `C-${index + 1}`,
              name: row[mapping.name!] || `Customer ${index + 1}`,
              group: group,
              lat: lat,
              lng: lng,
              frequency: frequency,
              visitTime: visitTime,
            };
          })
          .filter((c): c is Customer => c !== null);
        resolve(customers);
      },
      error: (error: Error) => {
        reject(error);
      },
    });
  });
};

export const exportToExcel = (plan: MasterPlanEntry[], groupName: string) => {
  if (!plan || plan.length === 0) {
    alert("No master plan data to export.");
    return;
  }
  const exportData = plan.map(visit => ({
    'Group (SR)': visit.assigned_group,
    'Visit_Date': visit.Visit_Date,
    'Visit_Day': visit.Visit_Day,
    'Zone_ID': visit.Zone_ID,
    'Visit_Sequence': visit.Visit_Sequence,
    'Distance_from_Prev_km': visit.Distance_from_Prev_km,
    'Est_Drive_Time_mins': visit.Est_Drive_Time_mins,
    'CustomerId': visit.CustomerId,
    'CustomerName': visit.CustomerName,
    'Frequency': visit.Frequency,
    'Latitude': visit.Latitude,
    'Longitude': visit.Longitude,
  }));
  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `SR Plan - ${groupName}`);
  XLSX.writeFile(wb, `SR_Monthly_Plan_${groupName}.xlsx`);
};

export const exportSpilloverToExcel = (plan: SpilloverEntry[], groupName: string) => {
  if (!plan || plan.length === 0) {
    alert("No spillover customer data to export.");
    return;
  }
  const ws = XLSX.utils.json_to_sheet(plan);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Spillover List - ${groupName}`);
  XLSX.writeFile(wb, `SR_Spillover_${groupName}.xlsx`);
};