import { Customer, Settings, MasterPlanEntry, SpilloverEntry, DailySummary } from '../types';

/*
 * =================================================================================================
 * SR MONTHLY ROUTE PLANNER - CORE PLANNING SERVICE
 * =================================================================================================
 *
 * DESIGN PHILOSOPHY & ALGORITHM EVOLUTION HISTORY
 *
 * V17: Spatial Coherence Engine. This version addresses a key weakness of standard K-Means.
 *      Even with balanced workloads, the initial geographic zones could be disjointed, containing
 *      "geographic outliers" that resulted in inefficient routes.
 *
 *      - PRE-BALANCING VALIDATION: A new stage is inserted after K-Means but BEFORE workload
 *        balancing.
 *      - OUTLIER DETECTION: It validates the spatial coherence of each zone, identifying customers
 *        that are too far from their zone's core cluster using a robust percentile-based threshold.
 *      - INTELLIGENT RE-ASSIGNMENT: These outliers are then re-assigned to the nearest suitable
 *        zone where they fit geographically, ensuring all zones are compact before balancing.
 *      - This results in routes that are both balanced AND geographically efficient.
 *
 * V16: Dynamic Weekly Scheduling Engine. Addresses weekly imbalances by dynamically scheduling
 *      high-frequency customers based on real-time load tracking and a weighted score of
 *      workload vs. geographic proximity.
 *
 * V15: Advanced Balancing with Iterative Optimization. The core "Geography First, then Balance"
 *      paradigm for creating balanced MONTHLY workloads per zone.
 * -------------------------------------------------------------------------------------------------
 */
const PLANNING_WEEKS = 4;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_INTRA_CLUSTER_DISTANCE_KM = 8; // Max acceptable distance for an outlier from its new home

// --- GEOSPATIAL & WORKLOAD UTILITIES ---

const haversineDistance = (
  coords1: { lat: number; lng: number } | Customer,
  coords2: { lat: number; lng: number } | Customer
): number => {
  const c1 = { lat: 'latitude' in coords1 ? coords1.latitude : coords1.lat, lng: 'longitude' in coords1 ? coords1.longitude : coords1.lng };
  const c2 = { lat: 'latitude' in coords2 ? coords2.latitude : coords2.lat, lng: 'longitude' in coords2 ? coords2.longitude : coords2.lng };

  if (isNaN(c1.lat) || isNaN(c1.lng) || isNaN(c2.lat) || isNaN(c2.lng)) return Infinity;
  
  const toRad = (x: number) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(c2.lat - c1.lat);
  const dLon = toRad(c2.lng - c1.lng);
  const lat1 = toRad(c1.lat);
  const lat2 = toRad(c2.lat);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

function getMonthlyWorkload(freq: number): number {
  return freq * PLANNING_WEEKS;
}

const calculateCentroid = (customers: Customer[]): { lat: number; lng: number } => {
  if (customers.length === 0) return { lat: 0, lng: 0 };
  let validCustomers = customers.filter(c => !isNaN(c.lat) && !isNaN(c.lng));
  if (validCustomers.length === 0) return { lat: 0, lng: 0 };
  const totalLat = validCustomers.reduce((sum, c) => sum + (c.lat || 0), 0);
  const totalLng = validCustomers.reduce((sum, c) => sum + (c.lng || 0), 0);
  return { lat: totalLat / validCustomers.length, lng: totalLng / validCustomers.length };
};

const updateCentroid = (zone: { customers: Customer[], centroid: { lat: number, lng: number }}) => {
    if (zone.customers.length === 0) return;
    zone.centroid = calculateCentroid(zone.customers);
};

// --- CORE BALANCING METRICS & SIMULATION ---

type ZoneWithWorkload = { totalWorkload: number };

function calculateLoadVariance(zones: ZoneWithWorkload[]): number {
  if (zones.length < 2) return 0;
  const loads = zones.map(z => z.totalWorkload);
  const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
  return loads.reduce((sum, load) => sum + Math.pow(load - mean, 2), 0) / loads.length;
}

function simulateMoveVariance(zones: ZoneWithWorkload[], customerWorkload: number, fromIndex: number, toIndex: number): number {
    const tempLoads = zones.map(z => z.totalWorkload);
    tempLoads[fromIndex] -= customerWorkload;
    tempLoads[toIndex] += customerWorkload;
    const mean = tempLoads.reduce((a, b) => a + b, 0) / tempLoads.length;
    return tempLoads.reduce((sum, load) => sum + Math.pow(load - mean, 2), 0) / tempLoads.length;
}

function simulateSwapVariance(zones: ZoneWithWorkload[], workloadA: number, workloadB: number, indexA: number, indexB: number): number {
    const tempLoads = zones.map(z => z.totalWorkload);
    tempLoads[indexA] = tempLoads[indexA] - workloadA + workloadB;
    tempLoads[indexB] = tempLoads[indexB] - workloadB + workloadA;
    const mean = tempLoads.reduce((a, b) => a + b, 0) / tempLoads.length;
    return tempLoads.reduce((sum, load) => sum + Math.pow(load - mean, 2), 0) / tempLoads.length;
}

// --- TYPE DEFINITIONS for ALGORITHM ---
interface WeightedCustomer extends Customer {
  workload: number;
}
interface ZoneAssignment {
  customers: WeightedCustomer[];
  totalWorkload: number;
  centroid: { lat: number; lng: number };
}
interface MoveCandidate {
    customer: WeightedCustomer;
    fromZoneIndex: number;
    toZoneIndex: number;
    varianceReduction: number;
    geographicCost: number;
    score: number;
}
interface SwapCandidate {
    customerA: WeightedCustomer;
    customerB: WeightedCustomer;
    zoneAIndex: number;
    zoneBIndex: number;
    varianceReduction: number;
}

// --- SPATIAL COHERENCE ENGINE (V17) ---

function removeGeographicOutliers(zone: ZoneAssignment, maxDistanceThreshold: number): { cleanedCustomers: WeightedCustomer[], outliers: WeightedCustomer[] } {
    if (zone.customers.length <= 2) return { cleanedCustomers: zone.customers, outliers: [] };

    const distancesToCentroid = zone.customers.map(c => ({
        customer: c,
        dist: haversineDistance(c, zone.centroid)
    })).sort((a, b) => a.dist - b.dist);
    
    const percentile85Index = Math.floor(distancesToCentroid.length * 0.85);
    const distanceLimit = Math.min(
        distancesToCentroid[percentile85Index].dist * 1.5,
        maxDistanceThreshold
    );
    
    const cleanedCustomers: WeightedCustomer[] = [];
    const outliers: WeightedCustomer[] = [];
    
    distancesToCentroid.forEach(({ customer, dist }) => {
        if (dist <= distanceLimit) {
            cleanedCustomers.push(customer);
        } else {
            outliers.push(customer);
        }
    });
    
    return { cleanedCustomers, outliers };
}

function findBestZoneForOutlier(outlier: WeightedCustomer, zones: ZoneAssignment[], maxDistanceThreshold: number): number | null {
    let bestZoneIndex: number | null = null;
    let minDistance = Infinity;

    zones.forEach((zone, idx) => {
        const distToCentroid = haversineDistance(outlier, zone.centroid);
        if (distToCentroid < maxDistanceThreshold && distToCentroid < minDistance) {
            const wouldViolate = zone.customers.some(c => haversineDistance(outlier, c) > maxDistanceThreshold * 1.5);
            if (!wouldViolate) {
                minDistance = distToCentroid;
                bestZoneIndex = idx;
            }
        }
    });

    return bestZoneIndex;
}

function validateAndFixSpatialCoherence(zones: ZoneAssignment[]): ZoneAssignment[] {
    const validatedZones: ZoneAssignment[] = [];
    const allOutliers: WeightedCustomer[] = [];

    zones.forEach((zone, zoneIdx) => {
        const { cleanedCustomers, outliers } = removeGeographicOutliers(zone, MAX_INTRA_CLUSTER_DISTANCE_KM);
        validatedZones.push({
            ...zone,
            customers: cleanedCustomers,
            totalWorkload: cleanedCustomers.reduce((sum, c) => sum + c.workload, 0)
        });
        allOutliers.push(...outliers);
    });

    allOutliers.forEach(outlier => {
        const bestZoneIdx = findBestZoneForOutlier(outlier, validatedZones, MAX_INTRA_CLUSTER_DISTANCE_KM);
        if (bestZoneIdx !== null) {
            validatedZones[bestZoneIdx].customers.push(outlier);
            validatedZones[bestZoneIdx].totalWorkload += outlier.workload;
        } else {
            const lightestZoneIdx = validatedZones.reduce((minIdx, z, idx, arr) => 
                z.totalWorkload < arr[minIdx].totalWorkload ? idx : minIdx, 0
            );
            validatedZones[lightestZoneIdx].customers.push(outlier);
            validatedZones[lightestZoneIdx].totalWorkload += outlier.workload;
        }
    });

    validatedZones.forEach(updateCentroid);
    return validatedZones;
}

// --- ADVANCED BALANCING LOGIC (V15) ---

function calculateGeographicCost(customer: Customer, targetZone: ZoneAssignment): number {
    const distToCentroid = haversineDistance(customer, targetZone.centroid);
    let minDistToMember = Infinity;
    if (targetZone.customers.length > 0) {
        for (const member of targetZone.customers) {
            const dist = haversineDistance(customer, member);
            if (dist < minDistToMember) minDistToMember = dist;
        }
    } else {
        minDistToMember = distToCentroid; // Fallback if target zone is empty
    }
    return (distToCentroid * 0.6 + minDistToMember * 0.4);
}

function findBestMove(zones: ZoneAssignment[]): MoveCandidate | null {
    const currentVariance = calculateLoadVariance(zones);
    const candidates: MoveCandidate[] = [];

    const sortedZones = zones.map((z, idx) => ({ zone: z, index: idx }))
        .sort((a, b) => b.zone.totalWorkload - a.zone.totalWorkload);
    
    const overloaded = sortedZones[0];
    const underloaded = sortedZones[sortedZones.length - 1];

    if (overloaded.zone.totalWorkload - underloaded.zone.totalWorkload <= 2) return null;

    for (const customer of overloaded.zone.customers) {
        if (overloaded.zone.customers.length <= 1) continue;
        const newVariance = simulateMoveVariance(zones, customer.workload, overloaded.index, underloaded.index);
        const varianceReduction = currentVariance - newVariance;

        if (varianceReduction > 0) {
            const geoCost = calculateGeographicCost(customer, underloaded.zone);
            candidates.push({
                customer,
                fromZoneIndex: overloaded.index,
                toZoneIndex: underloaded.index,
                varianceReduction,
                geographicCost: geoCost,
                score: 0 // will calculate next
            });
        }
    }

    if (candidates.length === 0) return null;

    candidates.forEach(c => {
        c.score = (c.varianceReduction * 0.7) - (c.geographicCost * 0.3);
    });
    
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
}

function findBorderCustomers(zone: ZoneAssignment, targetCentroid: { lat: number, lng: number }, count: number): WeightedCustomer[] {
    return [...zone.customers]
        .sort((a, b) => haversineDistance(a, targetCentroid) - haversineDistance(b, targetCentroid))
        .slice(0, count);
}

function findBestSwap(zones: ZoneAssignment[]): SwapCandidate | null {
    const currentVariance = calculateLoadVariance(zones);
    let bestSwap: SwapCandidate | null = null;

    for (let i = 0; i < zones.length; i++) {
        for (let j = i + 1; j < zones.length; j++) {
            const zoneA = zones[i];
            const zoneB = zones[j];

            if (Math.abs(zoneA.totalWorkload - zoneB.totalWorkload) <= 1) continue;

            const borderCustomersA = findBorderCustomers(zoneA, zoneB.centroid, 3);
            const borderCustomersB = findBorderCustomers(zoneB, zoneA.centroid, 3);

            for (const custA of borderCustomersA) {
                for (const custB of borderCustomersB) {
                    if (custA.workload === custB.workload) continue;

                    const newVariance = simulateSwapVariance(zones, custA.workload, custB.workload, i, j);
                    const varianceReduction = currentVariance - newVariance;

                    if (varianceReduction > 0 && (!bestSwap || varianceReduction > bestSwap.varianceReduction)) {
                        bestSwap = {
                            customerA: custA,
                            customerB: custB,
                            zoneAIndex: i,
                            zoneBIndex: j,
                            varianceReduction
                        };
                    }
                }
            }
        }
    }
    return bestSwap;
}

function executeMove(zones: ZoneAssignment[], move: MoveCandidate) {
    const fromZone = zones[move.fromZoneIndex];
    const toZone = zones[move.toZoneIndex];
    const customerIndex = fromZone.customers.findIndex(c => c.id === move.customer.id);
    if (customerIndex === -1) return;

    const [customer] = fromZone.customers.splice(customerIndex, 1);
    toZone.customers.push(customer);

    fromZone.totalWorkload -= customer.workload;
    toZone.totalWorkload += customer.workload;
    
    updateCentroid(fromZone);
    updateCentroid(toZone);
}

function executeSwap(zones: ZoneAssignment[], swap: SwapCandidate) {
    const zoneA = zones[swap.zoneAIndex];
    const zoneB = zones[swap.zoneBIndex];
    const indexA = zoneA.customers.findIndex(c => c.id === swap.customerA.id);
    const indexB = zoneB.customers.findIndex(c => c.id === swap.customerB.id);

    if (indexA === -1 || indexB === -1) return;
    
    const [custA] = zoneA.customers.splice(indexA, 1);
    const [custB] = zoneB.customers.splice(indexB, 1);

    zoneA.customers.push(custB);
    zoneB.customers.push(custA);
    
    zoneA.totalWorkload = zoneA.totalWorkload - custA.workload + custB.workload;
    zoneB.totalWorkload = zoneB.totalWorkload - custB.workload + custA.workload;

    updateCentroid(zoneA);
    updateCentroid(zoneB);
}


function smartSeedClustering(customers: Customer[], k: number): ZoneAssignment[] {
  const weightedCustomers: WeightedCustomer[] = customers.map(c => ({
    ...c,
    workload: getMonthlyWorkload(c.frequency),
  })).filter(c => !isNaN(c.lat) && !isNaN(c.lng));

  if (weightedCustomers.length < k) {
    throw new Error('Not enough customers with valid coordinates to form the requested number of zones.');
  }

  // --- STAGE 1: GEOGRAPHY-FIRST K-MEANS CLUSTERING ---
  let centroids: { lat: number, lng: number }[] = [];
  let remaining = [...weightedCustomers];
  centroids.push(remaining.splice(Math.floor(Math.random() * remaining.length), 1)[0]);
  
  while (centroids.length < k) {
    let distances = remaining.map(c => Math.min(...centroids.map(cent => haversineDistance(c, cent))) ** 2);
    let sum = distances.reduce((a, b) => a + b, 0);
    let chosen = Math.random() * sum;
    let cumulative = 0;
    let nextSeedIndex = remaining.findIndex((_, i) => (cumulative += distances[i]) >= chosen);
    if (nextSeedIndex === -1) nextSeedIndex = remaining.length - 1;
    centroids.push(remaining.splice(nextSeedIndex, 1)[0]);
  }
  
  let zones: ZoneAssignment[] = [];
  const MAX_KMEANS_ITERATIONS = 30;
  for (let i = 0; i < MAX_KMEANS_ITERATIONS; i++) {
    zones = Array.from({ length: k }, () => ({ customers: [], totalWorkload: 0, centroid: { lat: 0, lng: 0 } }));
    for (const customer of weightedCustomers) {
      let nearestCentroidIndex = 0;
      let minDistance = Infinity;
      for (let j = 0; j < k; j++) {
        const distance = haversineDistance(customer, centroids[j]);
        if (distance < minDistance) {
          minDistance = distance;
          nearestCentroidIndex = j;
        }
      }
      zones[nearestCentroidIndex].customers.push(customer);
    }
    
    let newCentroids = zones.map(zone => calculateCentroid(zone.customers));
    if (centroids.every((old, idx) => haversineDistance(old, newCentroids[idx]) < 0.1)) break;
    centroids = newCentroids;
  }
  
  zones.forEach(zone => {
    zone.totalWorkload = zone.customers.reduce((sum, c) => sum + c.workload, 0);
    zone.centroid = calculateCentroid(zone.customers);
  });

  // --- STAGE 1.5: SPATIAL COHERENCE VALIDATION & CORRECTION (V17) ---
  console.log("Stage 1.5: Validating spatial coherence and fixing outliers...");
  zones = validateAndFixSpatialCoherence(zones);
  
  // --- STAGE 2: ADVANCED WORKLOAD BALANCING (ITERATIVE OPTIMIZATION) ---
  console.log("Stage 2: Starting advanced workload balancing...");
  const MAX_BALANCE_ITERATIONS = 100;
  
  for (let i = 0; i < MAX_BALANCE_ITERATIONS; i++) {
    const stdDev = Math.sqrt(calculateLoadVariance(zones));
    if (stdDev < 2.0) break;

    let improved = false;
    const bestMove = findBestMove(zones);
    if (bestMove && bestMove.varianceReduction > 0.5) {
        executeMove(zones, bestMove);
        improved = true;
    }

    if (!improved) {
        const bestSwap = findBestSwap(zones);
        if (bestSwap && bestSwap.varianceReduction > 0.3) {
            executeSwap(zones, bestSwap);
            improved = true;
        }
    }
    if (!improved) break;
  }
  console.log("Balancing complete. Final workload variance:", calculateLoadVariance(zones));
  
  return zones;
}

// --- DYNAMIC SCHEDULING ENGINE (V16) ---

interface VisitAllocation {
    customer: Customer;
    visitDates: string[];
}

function selectAuxiliaryDayByLoad(
    primaryDay: string,
    workDays: number,
    weeklyLoads: Record<string, number>,
    zones: ZoneAssignment[],
    primaryDayIndex: number,
    customer: Customer
): string {
    const candidates: Array<{day: string, score: number}> = [];
    
    for (let d = 0; d < workDays; d++) {
        if (d === primaryDayIndex) continue;
        
        const dayName = DAY_NAMES[d];
        const totalLoad = Array.from({length: PLANNING_WEEKS}, (_, i) => i + 1)
            .reduce((sum, w) => sum + weeklyLoads[`W${w}-${dayName}`], 0);
        
        const geoDistance = haversineDistance(customer, zones[d].centroid);
        const score = -(totalLoad * 0.7 + geoDistance * 0.3);
        
        candidates.push({ day: dayName, score });
    }
    
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length > 0 ? candidates[0].day : DAY_NAMES[(primaryDayIndex + 1) % workDays];
}

function selectDatesForLowFreq(
    frequency: number,
    primaryDay: string,
    weeklyLoads: Record<string, number>
): string[] {
    const dates: string[] = [];
    const weeks = Array.from({length: PLANNING_WEEKS}, (_, i) => i + 1);
    
    weeks.sort((a, b) => weeklyLoads[`W${a}-${primaryDay}`] - weeklyLoads[`W${b}-${primaryDay}`]);

    for (let i = 0; i < frequency; i++) {
        const selectedWeek = weeks[i % PLANNING_WEEKS]; // Cycle through weeks if freq > 4
        const date = `W${selectedWeek}-${primaryDay}`;
        dates.push(date);
        weeklyLoads[date]++;
    }
    
    return dates;
}

function allocateVisitsWithDynamicLoadBalancing(
    zones: ZoneAssignment[],
    workDays: number
): VisitAllocation[] {
    const allocations: VisitAllocation[] = [];
    
    const weeklyLoads: Record<string, number> = {};
    for (let w = 1; w <= PLANNING_WEEKS; w++) {
        for (let d = 0; d < workDays; d++) {
            weeklyLoads[`W${w}-${DAY_NAMES[d]}`] = 0;
        }
    }
    
    const allCustomers: Array<{zoneIndex: number, customer: Customer}> = [];
    zones.forEach((zone, zoneIdx) => {
        zone.customers.forEach(c => allCustomers.push({ zoneIndex: zoneIdx, customer: c as Customer }));
    });
    allCustomers.sort((a, b) => b.customer.frequency - a.customer.frequency);
    
    for (const { zoneIndex, customer } of allCustomers) {
        const primaryDay = DAY_NAMES[zoneIndex];
        const visitDates: string[] = [];
        
        if (customer.frequency === 8) { // Special handling for twice-a-week
            const auxiliaryDay = selectAuxiliaryDayByLoad(primaryDay, workDays, weeklyLoads, zones, zoneIndex, customer);
            for (let w = 1; w <= PLANNING_WEEKS; w++) {
                const primaryDate = `W${w}-${primaryDay}`;
                const auxDate = `W${w}-${auxiliaryDay}`;
                visitDates.push(primaryDate, auxDate);
                weeklyLoads[primaryDate]++;
                weeklyLoads[auxDate]++;
            }
        } else { // Handles freq 1, 2, 4, and others
            const datesForThisCustomer = selectDatesForLowFreq(customer.frequency, primaryDay, weeklyLoads);
            visitDates.push(...datesForThisCustomer);
        }
        allocations.push({ customer, visitDates });
    }

    console.log('=== Final Weekly Load Distribution (Total Visits per Day of Week) ===');
    for (let d = 0; d < workDays; d++) {
        const day = DAY_NAMES[d];
        const weeklyTotal = Array.from({length: PLANNING_WEEKS}, (_, i) => i + 1)
            .reduce((sum, w) => sum + weeklyLoads[`W${w}-${day}`], 0);
        console.log(`${day}: ${weeklyTotal} visits`);
    }
    
    return allocations;
}

// --- MAIN PLUG-AND-PLAY FUNCTIONS ---

export const checkCapacity = (customers: Customer[], settings: Settings): { requiredLimit: number, dailyLoads: {day: string, load: number}[] } => {
    const { workDays: k } = settings;
    if (!customers || customers.length === 0) return { requiredLimit: 0, dailyLoads: [] };

    const zones = smartSeedClustering(customers, k);
    const allocations = allocateVisitsWithDynamicLoadBalancing(zones, k);

    const dailyLoads: Record<string, number> = {};
    allocations.forEach(alloc => {
        alloc.visitDates.forEach(date => {
            if (!dailyLoads[date]) dailyLoads[date] = 0;
            dailyLoads[date]++;
        });
    });
    
    const maxLoad = Math.max(0, ...Object.values(dailyLoads));
    
    let busiestDayInfo = { day: 'N/A', load: maxLoad };
    for(const date in dailyLoads) {
      if(dailyLoads[date] === maxLoad) {
        busiestDayInfo.day = date.split('-')[1];
        break;
      }
    }

    return { requiredLimit: maxLoad, dailyLoads: [busiestDayInfo] };
}

export function reoptimizeDailyRoute(
    visitsForDay: MasterPlanEntry[],
    zoneCentroid: { lat: number; lng: number },
    settings: Settings
): { reoptimizedVisits: MasterPlanEntry[], summary: { distance: string, time: string } } {
    if (!visitsForDay || visitsForDay.length === 0) {
        return { reoptimizedVisits: [], summary: { distance: '0.00', time: '0.00' } };
    }
    
    let remainingToVisit = visitsForDay.map(v => ({
        ...v,
        id: v.CustomerId,
        name: v.CustomerName,
        lat: v.Latitude,
        lng: v.Longitude,
    }));

    let optimizedList: any[] = [];
    let currentPoint: { lat: number, lng: number } = zoneCentroid;

    while (remainingToVisit.length > 0) {
        let nearestIndex = -1;
        let minDistance = Infinity;
        for (let i = 0; i < remainingToVisit.length; i++) {
            const distance = haversineDistance(currentPoint, remainingToVisit[i]);
            if (distance < minDistance) {
                minDistance = distance;
                nearestIndex = i;
            }
        }
        const nearestCustomer = remainingToVisit.splice(nearestIndex, 1)[0];
        optimizedList.push(nearestCustomer);
        currentPoint = nearestCustomer;
    }
    
    let totalDailyDistance = 0;
    let lastPoint: { lat: number, lng: number } | null = null;
    const reoptimizedVisits: MasterPlanEntry[] = [];

    optimizedList.forEach((customer, index) => {
        let distance = 0;
        let timeMins = 0;
        
        if (index > 0 && lastPoint) {
            distance = haversineDistance(lastPoint, customer);
        } else {
            distance = haversineDistance(zoneCentroid, customer);
        }
        timeMins = (distance / settings.avgSpeedKmph) * 60;
        totalDailyDistance += distance;
        
        reoptimizedVisits.push({
            ...customer,
            Visit_Sequence: index + 1,
            Distance_from_Prev_km: distance.toFixed(2),
            Est_Drive_Time_mins: timeMins.toFixed(0),
        });
        lastPoint = customer;
    });

    return {
        reoptimizedVisits,
        summary: {
            distance: totalDailyDistance.toFixed(2),
            time: (totalDailyDistance / settings.avgSpeedKmph).toFixed(2),
        }
    };
}


export async function runPlanningAlgorithm(
  customers: Customer[],
  settings: Settings
): Promise<{
  masterPlan: MasterPlanEntry[];
  spilloverPlan: SpilloverEntry[];
  dailySummaries: DailySummary[];
  zoneCentroids: { lat: number, lng: number }[];
}> {
  const { dailyVisitLimit: maxVisits, avgSpeedKmph: avgSpeed, workDays: k } = settings;
  if (customers.length === 0) throw new Error('No customers to plan for in this group.');

  // STAGE 1 & 2: Get geographically and monthly-load balanced zones
  const zones = smartSeedClustering(customers, k);
  const zoneCentroids = zones.map(zone => zone.centroid);
  
  // STAGE 3: Use the new dynamic scheduler to get weekly-load balanced visit dates
  const allocations = allocateVisitsWithDynamicLoadBalancing(zones, k);

  const visitsPerDay: Record<string, Customer[]> = {};
  allocations.forEach(({ customer, visitDates }) => {
    visitDates.forEach(date => {
      if (!visitsPerDay[date]) visitsPerDay[date] = [];
      visitsPerDay[date].push(customer);
    });
  });

  const masterPlan: MasterPlanEntry[] = [];
  const dailySummaries: Record<string, DailySummary> = {};
  const spilloverPlan: SpilloverEntry[] = [];
  
  const allDates = Object.keys(visitsPerDay).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const dateString of allDates) {
    const [weekStr, dayName] = dateString.split('-');
    const dayIndex = DAY_NAMES.indexOf(dayName);
    if (dayIndex === -1) continue;

    const scheduledCustomers = visitsPerDay[dateString];
    
    const visitsForTodayRaw: MasterPlanEntry[] = scheduledCustomers.map(customer => ({
      ...customer,
      assigned_group: customer.group,
      Visit_Date: dateString,
      Visit_Day: dayName,
      Zone_ID: `Zone_${dayIndex + 1}`, // This is now based on day, not original zone
      Visit_Sequence: 0,
      Distance_from_Prev_km: '0.00',
      Est_Drive_Time_mins: '0',
      CustomerId: customer.id,
      CustomerName: customer.name,
      Frequency: customer.frequency,
      Latitude: customer.lat,
      Longitude: customer.lng,
    }));
      
    const { reoptimizedVisits } = reoptimizeDailyRoute(visitsForTodayRaw, zoneCentroids[dayIndex], settings);
    
    const visitsForToday = reoptimizedVisits.slice(0, maxVisits);
    const newSpillovers = reoptimizedVisits.slice(maxVisits);
    
    if (newSpillovers.length > 0) {
        newSpillovers.forEach(spill => {
            spilloverPlan.push({
                assigned_group: spill.assigned_group,
                Spillover_Date: dateString,
                Visit_Day: dayName,
                Zone_ID: spill.Zone_ID,
                CustomerId: spill.CustomerId,
                CustomerName: spill.CustomerName,
                Frequency: spill.Frequency,
                Spillover_Reason: "Daily capacity exceeded",
            });
        });
    }

    masterPlan.push(...visitsForToday);
    
    const totalDailyDistance = visitsForToday.reduce((sum, v) => sum + parseFloat(v.Distance_from_Prev_km), 0);
    dailySummaries[dateString] = {
      date: dateString,
      day: dayName,
      visits: visitsForToday.length,
      spillovers: newSpillovers.length,
      distance: totalDailyDistance.toFixed(2),
      time: (totalDailyDistance / avgSpeed).toFixed(2),
    };
  }
  
  return {
    masterPlan,
    spilloverPlan,
    dailySummaries: Object.values(dailySummaries).sort((a,b) => a.date.localeCompare(b.date, undefined, { numeric: true })),
    zoneCentroids
  };
}