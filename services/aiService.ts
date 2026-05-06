import { MasterPlanEntry, Settings } from '../types';

export interface AIChange {
  type: 'move_day';
  customerId?: string;
  fromDay: string;
  toDay: string;
  filter?: { frequency?: number; day?: string };
}

export interface AIResponse {
  message: string;
  changes?: AIChange[];
  model?: string;
}

export async function askAI(
  instruction: string,
  plan: MasterPlanEntry[],
  settings: Settings,
): Promise<AIResponse> {
  const planSummary = plan.reduce(
    (acc, v) => {
      if (!acc[v.Visit_Date]) {
        acc[v.Visit_Date] = { visits: 0, distance: '0', day: v.Visit_Day };
      }
      acc[v.Visit_Date].visits++;
      acc[v.Visit_Date].distance = (
        parseFloat(acc[v.Visit_Date].distance) + parseFloat(v.Distance_from_Prev_km)
      ).toFixed(2);
      return acc;
    },
    {} as Record<string, { visits: number; distance: string; day: string }>,
  );

  const res = await fetch('/api/ai/adjust', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction, planSummary, settings }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  return res.json();
}
