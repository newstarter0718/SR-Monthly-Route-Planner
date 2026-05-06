import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Customer, Settings, MasterPlanEntry, SpilloverEntry } from './types';
import { parseCSV, exportToExcel, exportSpilloverToExcel } from './services/fileService';
import { runPlanningAlgorithm, checkCapacity, reoptimizeDailyRoute } from './services/planningService';
import { askAI, AIChange } from './services/aiService';
import { ErrorBoundary } from './ErrorBoundary';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Icons ────────────────────────────────────────────────────────────────────

const InfoIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
  </svg>
);

const WarningIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M8.257 3.099c.636-1.21 2.242-1.21 2.878 0l5.482 10.475A1.75 1.75 0 0115.196 16H4.804a1.75 1.75 0 01-1.421-2.426l5.482-10.475zM9 9a1 1 0 00-1 1v2a1 1 0 102 0v-2a1 1 0 00-1-1zm1 5a1 1 0 10-2 0 1 1 0 002 0z" clipRule="evenodd" />
  </svg>
);

const SuccessIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
  </svg>
);

const Spinner = () => (
  <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
  </svg>
);

const ChevronDownIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
  </svg>
);

// ── Helpers ──────────────────────────────────────────────────────────────────

const getWeekFromDateString = (dateStr: string): number => {
  const match = dateStr.match(/W(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
};

// ── GettingStartedGuide — defined outside App to avoid re-creation on every render

const GettingStartedGuide = () => (
  <div className="bg-white border border-gray-200 rounded-xl p-6 lg:p-8 shadow-sm mt-6">
    <h2 className="text-2xl font-semibold text-gray-900 mb-4">Welcome to the Route Planner!</h2>
    <p className="text-gray-600 mb-6">Here's how to get your optimized 4-week sales route in just a few clicks.</p>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 text-center">
      {[
        { n: 1, title: 'Configure Parameters', desc: 'Set your work schedule, daily visit limit, and average travel speed.' },
        { n: 2, title: 'Upload Your Data', desc: 'Upload a CSV with columns: group, latitude, longitude, frequency.' },
        { n: 3, title: 'Generate the Plan', desc: 'Select the Sales Rep (group) and click "Generate Plan".' },
      ].map(({ n, title, desc }) => (
        <div key={n} className="bg-gray-50 p-4 rounded-lg border">
          <div className="bg-red-600 text-white rounded-full w-10 h-10 flex items-center justify-center mx-auto mb-3 font-bold text-xl">{n}</div>
          <h3 className="font-semibold text-gray-800 mb-1">{title}</h3>
          <p className="text-sm text-gray-500">{desc}</p>
        </div>
      ))}
    </div>
    <div>
      <h3 className="text-xl font-semibold text-gray-900 mb-3">The 'Magic' Behind the Plan</h3>
      <ul className="space-y-3 text-gray-600">
        {[
          ['Geographic Clustering', 'Groups customers into dense daily zones to minimize travel.'],
          ['Spatial Coherence', 'Ensures each zone is a compact area, eliminating detours to outliers.'],
          ['Workload Balancing', 'Adjusts zones so each workday of the month has a similar number of visits.'],
          ['Dynamic Scheduling', 'Schedules multi-visit customers across the week to prevent overloads.'],
        ].map(([label, desc]) => (
          <li key={label} className="flex items-start">
            <strong className="text-red-600 font-semibold mr-2 w-44 flex-shrink-0">{label}:</strong>
            {desc}
          </li>
        ))}
      </ul>
    </div>
  </div>
);

// ── RouteMap ─────────────────────────────────────────────────────────────────

const RouteMap = ({
  visitsForWeek,
  onUpdateVisitDay,
  workDays,
  fullPlan,
}: {
  visitsForWeek: Record<string, MasterPlanEntry[]>;
  onUpdateVisitDay: (customerId: string, newDayName: string) => void;
  workDays: number;
  fullPlan: MasterPlanEntry[];
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.Layer[]>([]);
  const legendRef = useRef<L.Control | null>(null);
  const popupRef = useRef<L.Popup | null>(null);

  useEffect(() => {
    if (mapContainerRef.current && !mapInstanceRef.current) {
      mapInstanceRef.current = L.map(mapContainerRef.current).setView([23.5, 121], 7);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(mapInstanceRef.current);
    }
    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    popupRef.current?.remove();
    popupRef.current = null;
    layersRef.current.forEach(layer => map.removeLayer(layer));
    layersRef.current = [];
    if (legendRef.current) {
      map.removeControl(legendRef.current);
      legendRef.current = null;
    }

    if (!visitsForWeek || Object.keys(visitsForWeek).length === 0) return;

    const colors = ['#3388ff', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#ff7f0e'];
    const dayColorMap: Record<string, string> = {};
    const sortedDates = Object.keys(visitsForWeek).sort();

    sortedDates.forEach(date => {
      const day = visitsForWeek[date]?.[0]?.Visit_Day;
      if (day && !dayColorMap[day]) {
        dayColorMap[day] = colors[DAY_NAMES.indexOf(day) % colors.length];
      }
    });

    const allPoints: [number, number][] = [];
    const legendData: { color: string; day: string; date: string }[] = [];

    for (const date of sortedDates) {
      const visits = visitsForWeek[date];
      if (!visits?.length) continue;

      const dayOfWeek = visits[0].Visit_Day;
      const color = dayColorMap[dayOfWeek] || '#808080';

      if (!legendData.some(l => l.day === dayOfWeek)) {
        legendData.push({ color, day: dayOfWeek, date });
      }

      const latLngs = visits.map(v => [v.Latitude, v.Longitude] as [number, number]);
      allPoints.push(...latLngs);

      const polyline = L.polyline(latLngs, { color }).addTo(map);
      layersRef.current.push(polyline);

      visits.forEach(visit => {
        const icon = L.divIcon({
          html: `<div style="background-color:${color};" class="map-marker-icon">${visit.Visit_Sequence}</div>`,
          className: '',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });

        const marker = L.marker([visit.Latitude, visit.Longitude], { icon }).addTo(map);
        marker.on('click', () => {
          const popupContent = document.createElement('div');
          popupContent.className = 'p-1 text-xs text-gray-800 space-y-1';

          const getFreqDesc = (freq: number) =>
            ({ 8: 'Twice a week', 4: 'Once a week', 2: 'Twice a month', 1: 'Once a month' } as Record<number, string>)[freq] ?? 'Custom';

          const allVisitsForCustomer = fullPlan.filter(p => p.CustomerId === visit.CustomerId);
          const scheduledDays = [...new Set(allVisitsForCustomer.map(p => p.Visit_Day))].sort(
            (a, b) => DAY_NAMES.indexOf(a) - DAY_NAMES.indexOf(b),
          );

          popupContent.innerHTML = `
            <div class="font-bold text-sm mb-2 pb-1 border-b border-gray-300">${visit.CustomerName}</div>
            <div><b>Frequency:</b> ${visit.Frequency} <span class="text-gray-600">(${getFreqDesc(visit.Frequency)})</span></div>
            <div><b>Scheduled Days:</b> ${scheduledDays.join(', ')}</div>
            <div class="mt-1"><b>This Visit:</b> ${visit.Visit_Date}, #${visit.Visit_Sequence}</div>
          `;

          const form = document.createElement('div');
          form.className = 'mt-2 pt-2 border-t border-gray-300 flex items-center';

          const label = document.createElement('label');
          label.htmlFor = 'day-select';
          label.className = 'font-semibold mr-2';
          label.innerText = 'Change Day:';

          const select = document.createElement('select');
          select.id = 'day-select';
          select.className = 'border border-gray-300 rounded';

          DAY_NAMES.slice(0, workDays).forEach(dayName => {
            const option = document.createElement('option');
            option.value = dayName;
            option.text = dayName;
            if (dayName === visit.Visit_Day) option.selected = true;
            select.appendChild(option);
          });

          select.onchange = e => {
            const newDay = (e.target as HTMLSelectElement).value;
            if (newDay !== visit.Visit_Day) {
              onUpdateVisitDay(visit.CustomerId, newDay);
              map.closePopup();
            }
          };

          form.appendChild(label);
          form.appendChild(select);
          popupContent.appendChild(form);

          popupRef.current = L.popup()
            .setLatLng([visit.Latitude, visit.Longitude])
            .setContent(popupContent)
            .openOn(map);
        });
        layersRef.current.push(marker);
      });
    }

    const LegendControl = L.Control.extend({
      options: { position: 'topright' as L.ControlPosition },
      onAdd() {
        const div = L.DomUtil.create(
          'div',
          'bg-white/90 backdrop-blur-sm p-2 rounded-md border border-gray-300 text-gray-800 text-xs shadow-lg',
        );
        let html = '<h4 class="font-bold mb-1">Daily Routes</h4>';
        legendData
          .sort((a, b) => DAY_NAMES.indexOf(a.day) - DAY_NAMES.indexOf(b.day))
          .forEach(item => {
            html += `<div class="flex items-center my-1"><i style="background:${item.color};border:1px solid black;display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:6px"></i><span class="font-semibold">${item.day}</span><span class="ml-2 text-gray-500">${item.date}</span></div>`;
          });
        div.innerHTML = html;
        return div;
      },
    });
    const legend = new LegendControl();
    legend.addTo(map);
    legendRef.current = legend;

    if (allPoints.length > 0) {
      map.fitBounds(allPoints, { padding: [50, 50] });
    }
  }, [visitsForWeek, onUpdateVisitDay, workDays, fullPlan]);

  return <div ref={mapContainerRef} className="h-[600px] w-full rounded-lg border border-gray-200" />;
};

// ── AIAssistant panel ────────────────────────────────────────────────────────

const AIAssistant = ({
  plan,
  settings,
  onApplyChanges,
}: {
  plan: MasterPlanEntry[];
  settings: Settings;
  onApplyChanges: (changes: AIChange[]) => void;
}) => {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<{ message: string; changes?: AIChange[]; model?: string } | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const handleAsk = async () => {
    if (!input.trim()) return;
    setLoading(true);
    setResponse(null);
    setAiError(null);
    try {
      const result = await askAI(input, plan, settings);
      setResponse(result);
    } catch (err: any) {
      setAiError(err.message ?? 'AI request failed');
    } finally {
      setLoading(false);
    }
  };

  const handleApply = () => {
    if (response?.changes?.length) {
      onApplyChanges(response.changes);
      setResponse(null);
      setInput('');
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm mt-6">
      <h2 className="text-xl font-semibold text-gray-900 mb-1 flex items-center gap-2">
        <span className="text-red-600">✦</span> AI Route Assistant
        <span className="text-xs font-normal text-gray-400 ml-1">(Vertex AI · Gemini 2.5 Pro)</span>
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        Ask in plain English — e.g. "Which day is most overloaded?" or "Move all Friday frequency-1 customers to Saturday."
      </p>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !loading && handleAsk()}
          placeholder="Type an instruction or question…"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
        />
        <button
          onClick={handleAsk}
          disabled={loading || !input.trim()}
          className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2 text-sm font-semibold"
        >
          {loading ? <Spinner /> : 'Ask AI'}
        </button>
      </div>

      {aiError && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
          {aiError}
          {(aiError.includes('fetch') || aiError.includes('network') || aiError.includes('500')) && (
            <span className="block mt-1 text-xs text-red-500">
              Make sure the AI server is running: <code className="bg-red-100 px-1 rounded">npm run server</code>
            </span>
          )}
        </div>
      )}

      {response && (
        <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-3">
          <p className="text-sm text-gray-800 whitespace-pre-wrap">{response.message}</p>
          {response.model && <p className="text-xs text-gray-400">Model: {response.model}</p>}
          {response.changes && response.changes.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-600 mb-2">Proposed changes:</p>
              <ul className="text-xs text-gray-600 space-y-1">
                {response.changes.map((c, i) => (
                  <li key={i} className="flex items-center gap-1">
                    <span className="text-red-500">→</span>
                    {c.customerId
                      ? `Move customer ${c.customerId}: ${c.fromDay} → ${c.toDay}`
                      : `Move all ${c.filter?.day ?? c.fromDay} visits${c.filter?.frequency ? ` (freq ${c.filter.frequency})` : ''}: ${c.fromDay} → ${c.toDay}`}
                  </li>
                ))}
              </ul>
              <button
                onClick={handleApply}
                className="mt-3 bg-green-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-green-700"
              >
                Apply Changes
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [settings, setSettings] = useState<Settings>({ workDays: 5, dailyVisitLimit: 30, avgSpeedKmph: 30 });
  const [allCustomers, setAllCustomers] = useState<Customer[]>([]);
  const [detectedGroups, setDetectedGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [finalPlan, setFinalPlan] = useState<MasterPlanEntry[] | null>(null);
  const [spilloverPlan, setSpilloverPlan] = useState<SpilloverEntry[] | null>(null);
  const [zoneCentroids, setZoneCentroids] = useState<{ lat: number; lng: number }[] | null>(null);

  const [tabValue, setTabValue] = useState(0);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [selectedWeek, setSelectedWeek] = useState<number>(1);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Derived from finalPlan + spilloverPlan — single source of truth, no manual rebuild needed
  const summaryReport = useMemo(() => {
    if (!finalPlan) return null;
    const byDate: Record<string, { visits: number; day: string; distance: number }> = {};
    finalPlan.forEach(v => {
      if (!byDate[v.Visit_Date]) byDate[v.Visit_Date] = { visits: 0, day: v.Visit_Day, distance: 0 };
      byDate[v.Visit_Date].visits++;
      byDate[v.Visit_Date].distance += parseFloat(v.Distance_from_Prev_km);
    });
    const spillByDate: Record<string, number> = {};
    spilloverPlan?.forEach(s => { spillByDate[s.Spillover_Date] = (spillByDate[s.Spillover_Date] ?? 0) + 1; });
    return Object.entries(byDate)
      .map(([date, d]) => ({
        date,
        day: d.day,
        visits: d.visits,
        spillovers: spillByDate[date] ?? 0,
        distance: d.distance.toFixed(2),
        time: (d.distance / settings.avgSpeedKmph).toFixed(2),
      }))
      .sort((a, b) => a.date.localeCompare(b.date, undefined, { numeric: true }));
  }, [finalPlan, spilloverPlan, settings.avgSpeedKmph]);

  const resetResults = () => {
    setFinalPlan(null);
    setSpilloverPlan(null);
    setZoneCentroids(null);
    setError(null);
    setExpandedDays(new Set());
    setSelectedWeek(1);
  };

  const handleSettingsChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    resetResults();
    setSettings(prev => ({
      ...prev,
      [name]: name === 'workDays' ? parseInt(value, 10) : parseFloat(value),
    }));
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setIsLoading(true);
      setFileError(null);
      resetResults();
      setAllCustomers([]);
      setDetectedGroups([]);
      setSelectedGroup('');
      try {
        const parsed = await parseCSV(file);
        setAllCustomers(parsed);
        const groups = [...new Set(parsed.map(c => c.group))].sort();
        setDetectedGroups(groups);
      } catch (err: any) {
        setFileError(err.message || 'Failed to parse file.');
      } finally {
        setIsLoading(false);
      }
    }
    if (e.target) e.target.value = '';
  };

  const handleGroupChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedGroup(e.target.value);
    resetResults();
  };

  const handleSchedule = useCallback(async () => {
    if (!selectedGroup) { setError('Please select a group (Sales Rep) to start planning.'); return; }
    setIsLoading(true);
    resetResults();
    try {
      const customers = allCustomers.filter(c => c.group === selectedGroup);
      if (!customers.length) throw new Error(`No customers found in group "${selectedGroup}".`);
      const { masterPlan, spilloverPlan: sp, zoneCentroids: centroids } = await runPlanningAlgorithm(customers, settings);
      setFinalPlan(masterPlan);
      setSpilloverPlan(sp);
      setZoneCentroids(centroids);
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred during planning.');
    } finally {
      setIsLoading(false);
    }
  }, [selectedGroup, allCustomers, settings]);

  const smartSuggestion = useMemo(() => {
    if (!selectedGroup) return null;
    const customers = allCustomers.filter(c => c.group === selectedGroup);
    if (!customers.length) return null;
    const { requiredLimit, dailyLoads } = checkCapacity(customers, settings);
    const busiest = dailyLoads.reduce((max, d) => (d.load > max.load ? d : max), { day: '', load: 0 });
    return { requiredLimit, busiestDayInfo: `${busiest.day} (${busiest.load} visits/day)` };
  }, [selectedGroup, allCustomers, settings]);

  const frequencyDistribution = useMemo(() => {
    if (!selectedGroup) return null;
    const customers = allCustomers.filter(c => c.group === selectedGroup);
    if (!customers.length) return null;
    const getDesc = (f: number) =>
      ({ 8: 'Twice a week', 4: 'Once a week', 2: 'Twice a month', 1: 'Once a month' } as Record<number, string>)[f] ?? 'Custom';
    const dist = customers.reduce((acc, c) => { acc[c.frequency] = (acc[c.frequency] ?? 0) + 1; return acc; }, {} as Record<number, number>);
    return Object.entries(dist)
      .map(([freq, count]) => ({ freq: Number(freq), count, desc: getDesc(Number(freq)) }))
      .sort((a, b) => b.freq - a.freq);
  }, [selectedGroup, allCustomers]);

  const workloadAnalysis = useMemo(() => {
    if (!summaryReport) return null;
    const byDay = summaryReport.reduce((acc, r) => { acc[r.day] = (acc[r.day] ?? 0) + r.visits; return acc; }, {} as Record<string, number>);
    const loads = Object.values(byDay) as number[];
    if (!loads.length) return null;
    const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
    const variance = loads.reduce((s, v) => s + (v - mean) ** 2, 0) / loads.length;
    const stdDev = Math.sqrt(variance);
    return {
      mean: mean.toFixed(1),
      stdDev: stdDev.toFixed(2),
      min: Math.min(...loads),
      max: Math.max(...loads),
      coeffVariation: mean > 0 ? `${(stdDev / mean * 100).toFixed(1)}%` : 'N/A',
    };
  }, [summaryReport]);

  // Core day-change logic extracted so both map popup and AI assistant share it
  const applyDayChange = useCallback(
    (customerId: string, newDayName: string, currentPlan: MasterPlanEntry[], centroids: { lat: number; lng: number }[]): MasterPlanEntry[] => {
      const affectedDays = new Set<string>();
      let newPlan = currentPlan.map(v => {
        if (v.CustomerId !== customerId) return v;
        affectedDays.add(v.Visit_Day);
        affectedDays.add(newDayName);
        const week = getWeekFromDateString(v.Visit_Date);
        return { ...v, Visit_Day: newDayName, Visit_Date: `W${week}-${newDayName}`, Zone_ID: `Zone_${DAY_NAMES.indexOf(newDayName) + 1}` };
      });
      affectedDays.forEach(dayName => {
        const dayIndex = DAY_NAMES.indexOf(dayName);
        for (let week = 1; week <= 4; week++) {
          const dateStr = `W${week}-${dayName}`;
          const dayVisits = newPlan.filter(v => v.Visit_Date === dateStr);
          if (dayVisits.length) {
            const { reoptimizedVisits } = reoptimizeDailyRoute(dayVisits, centroids[dayIndex], settings);
            newPlan = [...newPlan.filter(v => v.Visit_Date !== dateStr), ...reoptimizedVisits];
          }
        }
      });
      return newPlan.sort((a, b) =>
        a.Visit_Date.localeCompare(b.Visit_Date, undefined, { numeric: true }) || a.Visit_Sequence - b.Visit_Sequence,
      );
    },
    [settings],
  );

  const handleUpdateVisitDay = useCallback(
    (customerId: string, newDayName: string) => {
      if (!finalPlan || !zoneCentroids) return;
      setFinalPlan(applyDayChange(customerId, newDayName, finalPlan, zoneCentroids));
    },
    [finalPlan, zoneCentroids, applyDayChange],
  );

  const handleApplyAIChanges = useCallback(
    (changes: AIChange[]) => {
      if (!finalPlan || !zoneCentroids) return;
      let plan = finalPlan;
      for (const change of changes) {
        if (change.type !== 'move_day') continue;
        if (change.customerId) {
          plan = applyDayChange(change.customerId, change.toDay, plan, zoneCentroids);
        } else {
          const targets = [...new Set(
            plan
              .filter(v => {
                if (change.filter?.day && v.Visit_Day !== change.filter.day) return false;
                if (change.filter?.frequency && v.Frequency !== change.filter.frequency) return false;
                return v.Visit_Day === change.fromDay;
              })
              .map(v => v.CustomerId),
          )];
          for (const id of targets) {
            plan = applyDayChange(id, change.toDay, plan, zoneCentroids);
          }
        }
      }
      setFinalPlan(plan);
    },
    [finalPlan, zoneCentroids, applyDayChange],
  );

  const planByDay = useMemo(() => {
    if (!finalPlan) return null;
    const grouped = finalPlan.reduce(
      (acc, v) => {
        if (!acc[v.Visit_Date]) acc[v.Visit_Date] = { details: [], totalDistance: 0, totalTimeMins: 0, dayOfWeek: v.Visit_Day };
        acc[v.Visit_Date].details.push(v);
        acc[v.Visit_Date].totalDistance += parseFloat(v.Distance_from_Prev_km);
        acc[v.Visit_Date].totalTimeMins += parseFloat(v.Est_Drive_Time_mins);
        return acc;
      },
      {} as Record<string, { details: MasterPlanEntry[]; totalDistance: number; totalTimeMins: number; dayOfWeek: string }>,
    );
    (Object.values(grouped) as { details: MasterPlanEntry[]; totalDistance: number; totalTimeMins: number; dayOfWeek: string }[]).forEach(d => d.details.sort((a, b) => a.Visit_Sequence - b.Visit_Sequence));
    return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  }, [finalPlan]);

  const planByWeek = useMemo(() => {
    if (!finalPlan) return {};
    return finalPlan.reduce(
      (acc, v) => {
        const week = getWeekFromDateString(v.Visit_Date);
        if (!acc[week]) acc[week] = {};
        if (!acc[week][v.Visit_Date]) acc[week][v.Visit_Date] = [];
        acc[week][v.Visit_Date].push(v);
        return acc;
      },
      {} as Record<number, Record<string, MasterPlanEntry[]>>,
    );
  }, [finalPlan]);

  const availableWeeks = useMemo(
    () => Object.keys(planByWeek).map(Number).sort((a, b) => a - b),
    [planByWeek],
  );

  useEffect(() => {
    if (availableWeeks.length > 0 && !availableWeeks.includes(selectedWeek)) setSelectedWeek(availableWeeks[0]);
  }, [availableWeeks, selectedWeek]);

  const TABS = ['Daily Summary', 'Plan Details', 'Route Map'];

  return (
    <div className="min-h-screen bg-gray-100 text-gray-800 p-4 sm:p-6 lg:p-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-red-600">SR Monthly Route Planner</h1>
        <p className="text-gray-600">V18.0 · Vertex AI Enhanced</p>
      </header>

      <main>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          {/* Step 1 — Settings */}
          <div className="bg-white border border-gray-200 rounded-xl p-6 flex flex-col space-y-4 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 flex items-center"><span className="text-red-600 font-bold mr-2">1.</span> Configure Parameters</h2>
            <div>
              <label htmlFor="workDays" className="block text-sm font-medium text-gray-600 mb-1">Work Days</label>
              <select name="workDays" id="workDays" value={settings.workDays} onChange={handleSettingsChange} className="w-full bg-white border-gray-300 rounded-md px-3 py-2 focus:ring-red-500 focus:border-red-500">
                <option value={5}>5 Days (Mon–Fri)</option>
                <option value={6}>6 Days (Mon–Sat)</option>
              </select>
            </div>
            <div>
              <label htmlFor="dailyVisitLimit" className="block text-sm font-medium text-gray-600 mb-1">Daily Visit Limit</label>
              <input type="number" name="dailyVisitLimit" id="dailyVisitLimit" value={settings.dailyVisitLimit} onChange={handleSettingsChange} className="w-full bg-white border-gray-300 rounded-md px-3 py-2 focus:ring-red-500 focus:border-red-500" />
            </div>
            <div>
              <label htmlFor="avgSpeedKmph" className="block text-sm font-medium text-gray-600 mb-1">Average Speed (km/h)</label>
              <input type="number" name="avgSpeedKmph" id="avgSpeedKmph" value={settings.avgSpeedKmph} onChange={handleSettingsChange} className="w-full bg-white border-gray-300 rounded-md px-3 py-2 focus:ring-red-500 focus:border-red-500" />
            </div>
            <div className="pt-2">
              <div className="p-3 bg-gray-50 text-gray-500 rounded-md text-sm flex items-start">
                <InfoIcon />
                <span>Fixed four-week planning cycle, independent of calendar months, for consistent results.</span>
              </div>
            </div>
          </div>

          {/* Step 2 — Upload */}
          <div className="bg-white border border-gray-200 rounded-xl p-6 flex flex-col space-y-4 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 flex items-center"><span className="text-red-600 font-bold mr-2">2.</span> Upload Customer List</h2>
            <button onClick={() => fileInputRef.current?.click()} disabled={isLoading} className="w-full bg-white text-red-600 border border-red-600 hover:bg-red-600 hover:text-white font-bold py-3 px-4 rounded-lg transition-colors duration-200 disabled:opacity-50">
              {isLoading ? 'Processing…' : 'Upload CSV File'}
            </button>
            <input type="file" ref={fileInputRef} hidden accept=".csv" onChange={handleFileChange} />
            {fileError && <div className="text-red-700 text-sm p-3 bg-red-100 border border-red-300 rounded-md">{fileError}</div>}
            {allCustomers.length > 0 && (
              <div className="text-green-800 text-sm p-3 bg-green-100 border border-green-300 rounded-md">
                <p className="font-bold">Successfully Loaded!</p>
                <p>{allCustomers.length} customers · {detectedGroups.length} groups</p>
              </div>
            )}
          </div>

          {/* Step 3 — Execute */}
          <div className="bg-white border border-gray-200 rounded-xl p-6 flex flex-col space-y-4 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 flex items-center"><span className="text-red-600 font-bold mr-2">3.</span> Execute Plan</h2>
            <div>
              <label htmlFor="group" className="block text-sm font-medium text-gray-600 mb-1">Select Group (Sales Rep)</label>
              <select id="group" value={selectedGroup} onChange={handleGroupChange} disabled={!detectedGroups.length || isLoading} className="w-full bg-white border-gray-300 rounded-md px-3 py-2 focus:ring-red-500 focus:border-red-500 disabled:opacity-50">
                <option value="">{detectedGroups.length ? 'Select a group' : 'Upload a file first'}</option>
                {detectedGroups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            {frequencyDistribution && (
              <div className="p-3 bg-gray-50 rounded-md text-sm border border-gray-200">
                <h4 className="font-semibold mb-2 text-gray-700">Visit Frequency Distribution:</h4>
                <ul className="space-y-1 text-gray-500">
                  {frequencyDistribution.map(item => (
                    <li key={item.freq} className="flex justify-between items-center">
                      <span>{item.desc} (Freq {item.freq}):</span>
                      <span className="font-bold text-gray-800 bg-gray-200 px-2 py-0.5 rounded-md">{item.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {workloadAnalysis && (
              <div className="p-3 bg-red-50 rounded-md text-sm border border-red-200">
                <h4 className="font-semibold mb-2 text-red-800">Weekly Workload Analysis:</h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600">
                  <div>Average: <span className="font-bold text-gray-900">{workloadAnalysis.mean}</span> / wk</div>
                  <div>Std. Dev: <span className="font-bold text-gray-900">{workloadAnalysis.stdDev}</span></div>
                  <div>Range: <span className="font-bold text-gray-900">{workloadAnalysis.min}–{workloadAnalysis.max}</span></div>
                  <div>Coeff. Var: <span className="font-bold text-gray-900">{workloadAnalysis.coeffVariation}</span></div>
                </div>
              </div>
            )}
            {smartSuggestion && smartSuggestion.requiredLimit > settings.dailyVisitLimit && (
              <div className="p-3 bg-yellow-100 text-yellow-800 rounded-md text-sm border border-yellow-300">
                <div className="flex items-start"><WarningIcon /><span className="font-bold">Capacity Warning</span></div>
                <p className="mt-1">Busiest day: <span className="font-bold">{smartSuggestion.busiestDayInfo}</span>. Limit: <span className="font-bold">{settings.dailyVisitLimit}</span>.</p>
                <button onClick={() => { setSettings(p => ({ ...p, dailyVisitLimit: smartSuggestion.requiredLimit })); resetResults(); }} className="mt-2 text-yellow-900 font-bold underline hover:text-black">Apply Suggestion ({smartSuggestion.requiredLimit})</button>
              </div>
            )}
            {smartSuggestion && smartSuggestion.requiredLimit <= settings.dailyVisitLimit && (
              <div className="p-3 bg-green-100 text-green-800 rounded-md text-sm flex items-center border border-green-300">
                <SuccessIcon />Capacity check passed. Limit of {settings.dailyVisitLimit} is sufficient.
              </div>
            )}
            <button onClick={handleSchedule} disabled={isLoading || !selectedGroup} className="w-full bg-red-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-red-700 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center h-12">
              {isLoading ? <Spinner /> : `Generate Plan for ${selectedGroup || '…'}`}
            </button>
          </div>
        </div>

        {!finalPlan && !error && <GettingStartedGuide />}

        {(finalPlan || error) && (
          <ErrorBoundary>
            <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">
                4. Planning Results: <span className="text-red-600">{selectedGroup}</span>
              </h2>
              {error && <div className="text-red-700 text-base p-4 bg-red-100 border border-red-300 rounded-md mb-4">{error}</div>}
              {summaryReport && finalPlan && spilloverPlan && !error && (
                <>
                  <div className="flex flex-wrap gap-4 mb-4">
                    <button onClick={() => exportToExcel(finalPlan, selectedGroup)} disabled={!finalPlan.length} className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg transition-colors duration-200 disabled:opacity-50">Export Master Plan</button>
                    <button onClick={() => exportSpilloverToExcel(spilloverPlan, selectedGroup)} disabled={!spilloverPlan.length} className="bg-gray-700 hover:bg-gray-800 text-white font-bold py-2 px-4 rounded-lg transition-colors duration-200 disabled:opacity-50">Export Spillover ({spilloverPlan.length})</button>
                  </div>
                  <div className={`p-4 rounded-md mb-4 flex items-center ${summaryReport.some(s => s.spillovers > 0) ? 'bg-yellow-100 text-yellow-800 border border-yellow-300' : 'bg-green-100 text-green-800 border border-green-300'}`}>
                    {summaryReport.some(s => s.spillovers > 0) ? <WarningIcon /> : <SuccessIcon />}
                    <span>Plan generated: <strong>{finalPlan.length}</strong> scheduled visits · <strong>{spilloverPlan.length}</strong> spillover customers.</span>
                  </div>
                  <div className="border-b border-gray-200 mb-4">
                    <nav className="flex space-x-4">
                      {TABS.map((tab, i) => (
                        <button key={tab} onClick={() => setTabValue(i)} className={`py-2 px-4 font-medium text-sm transition-colors duration-200 ${tabValue === i ? 'border-b-2 border-red-600 text-red-600' : 'text-gray-500 hover:text-gray-900'}`}>{tab}</button>
                      ))}
                    </nav>
                  </div>

                  <div className="overflow-x-auto max-h-[600px] bg-white rounded-lg border border-gray-200">
                    {tabValue === 0 && (
                      <table className="w-full text-sm text-left text-gray-700">
                        <thead className="bg-gray-100 sticky top-0">
                          <tr className="text-gray-500 uppercase text-xs">
                            <th className="p-3">Date</th><th className="p-3">Day</th><th className="p-3 text-right">Visits</th><th className="p-3 text-right">Spillovers</th><th className="p-3 text-right">Distance (km)</th><th className="p-3 text-right">Drive Time (hr)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summaryReport.map(r => (
                            <tr key={r.date} className="border-t border-gray-200 hover:bg-gray-50">
                              <td className="p-3 font-mono">{r.date}</td>
                              <td className="p-3">{r.day}</td>
                              <td className="p-3 text-right">{r.visits}</td>
                              <td className={`p-3 text-right ${r.spillovers > 0 ? 'text-yellow-600 font-bold' : ''}`}>{r.spillovers}</td>
                              <td className="p-3 text-right">{r.distance}</td>
                              <td className="p-3 text-right">{r.time}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    {tabValue === 1 && planByDay && (
                      <div>
                        {planByDay.map(([date, data]) => (
                          <div key={date} className="border-t border-gray-200">
                            <button
                              onClick={() => setExpandedDays(prev => { const s = new Set(prev); s.has(date) ? s.delete(date) : s.add(date); return s; })}
                              className="w-full flex justify-between items-center p-3 bg-gray-50 hover:bg-gray-100"
                            >
                              <div className="flex items-center space-x-4">
                                <ChevronDownIcon className={`w-5 h-5 transition-transform ${expandedDays.has(date) ? 'rotate-180' : ''}`} />
                                <span className="font-bold font-mono">{date}</span>
                              </div>
                              <div className="text-sm text-gray-500 grid grid-cols-3 gap-x-4 text-right">
                                <span>Visits: <span className="font-semibold text-gray-800">{data.details.length}</span></span>
                                <span>Distance: <span className="font-semibold text-gray-800">{data.totalDistance.toFixed(2)} km</span></span>
                                <span>Time: <span className="font-semibold text-gray-800">{(data.totalTimeMins / 60).toFixed(2)} hr</span></span>
                              </div>
                            </button>
                            {expandedDays.has(date) && (
                              <table className="w-full text-sm text-left text-gray-700 bg-white">
                                <thead className="bg-gray-100">
                                  <tr className="text-gray-500 uppercase text-xs">
                                    <th className="p-2">Seq</th><th className="p-2">Zone</th><th className="p-2">Customer ID</th><th className="p-2">Customer Name</th><th className="p-2 text-center">Freq</th><th className="p-2 text-right">Distance (km)</th><th className="p-2 text-right">Time (min)</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {data.details.map(v => (
                                    <tr key={`${v.Visit_Date}-${v.Visit_Sequence}`} className="border-t border-gray-200 hover:bg-gray-50">
                                      <td className="p-2 text-center">{v.Visit_Sequence}</td>
                                      <td className="p-2">{v.Zone_ID}</td>
                                      <td className="p-2 whitespace-nowrap">{v.CustomerId}</td>
                                      <td className="p-2 whitespace-nowrap">{v.CustomerName}</td>
                                      <td className="p-2 text-center">{v.Frequency}</td>
                                      <td className="p-2 text-right">{v.Distance_from_Prev_km}</td>
                                      <td className="p-2 text-right">{v.Est_Drive_Time_mins}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {tabValue === 2 && (
                      <div className="p-2 bg-gray-50">
                        <div className="mb-4">
                          <label htmlFor="week-select" className="text-sm font-medium text-gray-600 mr-2">Select Week:</label>
                          <select id="week-select" value={selectedWeek} onChange={e => setSelectedWeek(Number(e.target.value))} className="bg-white border-gray-300 rounded-md px-3 py-1 focus:ring-red-500 focus:border-red-500">
                            {availableWeeks.map(w => <option key={w} value={w}>Week {w}</option>)}
                          </select>
                        </div>
                        <RouteMap
                          visitsForWeek={planByWeek[selectedWeek] ?? {}}
                          onUpdateVisitDay={handleUpdateVisitDay}
                          workDays={settings.workDays}
                          fullPlan={finalPlan}
                        />
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {finalPlan && (
              <AIAssistant
                plan={finalPlan}
                settings={settings}
                onApplyChanges={handleApplyAIChanges}
              />
            )}
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}

export default App;
