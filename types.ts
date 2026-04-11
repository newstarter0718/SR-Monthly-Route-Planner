export interface Customer {
  id: string;
  name: string;
  group: string;
  lat: number;
  lng: number;
  frequency: number;
  visitTime: number;
  [key: string]: any;
}

export interface MasterPlanEntry {
  assigned_group: string;
  Visit_Date: string; // e.g., "W1-Mon"
  Visit_Day: string; // e.g., "Mon"
  Zone_ID: string;
  Visit_Sequence: number;
  Distance_from_Prev_km: string;
  Est_Drive_Time_mins: string;
  CustomerId: string;
  CustomerName: string;
  Frequency: number;
  Latitude: number;
  Longitude: number;
  [key: string]: any;
}

export interface SpilloverEntry {
  assigned_group: string;
  Spillover_Date: string; // e.g., "W4-Mon"
  Visit_Day: string;
  Zone_ID: string;
  CustomerId: string;
  CustomerName: string;
  Frequency: number;
  Spillover_Reason: string;
}

export interface DailySummary {
  date: string; // e.g., "W1-Mon"
  day: string;
  visits: number;
  spillovers: number;
  distance: string;
  time: string;
}

export interface Settings {
  workDays: 5 | 6;
  dailyVisitLimit: number;
  avgSpeedKmph: number;
}
