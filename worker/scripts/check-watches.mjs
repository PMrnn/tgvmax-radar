// TGVmax Radar — scheduled alert checker.
// Run by a GitHub Actions cron. Pulls every saved "watch" from the Cloudflare
// Worker, re-runs the same search logic used by the web app against the live
// SNCF API, and sends a real Web Push notification for anything newly
// matching (never re-notifying the same itinerary twice).
import webpush from "web-push";

const WORKER_URL = process.env.WORKER_URL;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "https://pmrnn.github.io/tgvmax-radar/";
const APP_URL = "https://pmrnn.github.io/tgvmax-radar/";

if (!WORKER_URL || !ADMIN_SECRET || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error("Variables d'environnement manquantes (WORKER_URL, ADMIN_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY).");
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const SNCF_API_URL = "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax/records";
const PAGE_SIZE = 100;
const MAX_PAGES_SAFETY = 60;
const MAX_RANGE_DAYS = 15;
const MAX_NOTIFIED_KEYS = 500;
// Safety budget: caps SNCF requests for this single run, well inside their 150k/day
// shared rate limit even if this job runs hourly (24 runs x this cap).
const MAX_SNCF_REQUESTS_PER_RUN = 3000;

let sncfRequestCount = 0;

function buildUrl(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => usp.append(k, x));
    else usp.append(k, v);
  }
  return SNCF_API_URL + "?" + usp.toString();
}

async function fetchJSON(url) {
  if (sncfRequestCount >= MAX_SNCF_REQUESTS_PER_RUN) {
    throw new Error(`Budget de requêtes SNCF atteint (${MAX_SNCF_REQUESTS_PER_RUN}/run) — arrêt anticipé.`);
  }
  sncfRequestCount++;
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Erreur API SNCF (${r.status}) : ${body.slice(0, 200)}`);
  }
  return r.json();
}

function hhmmToMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

const dayCache = new Map();
async function getDayTrains(date) {
  if (dayCache.has(date)) return dayCache.get(date);
  const refine = [`date:${date}`, `od_happy_card:OUI`];
  const first = await fetchJSON(buildUrl({ limit: PAGE_SIZE, offset: 0, refine }));
  let results = first.results.slice();
  const total = Math.min(first.total_count, PAGE_SIZE * MAX_PAGES_SAFETY);
  for (let off = PAGE_SIZE; off < total; off += PAGE_SIZE) {
    const page = await fetchJSON(buildUrl({ limit: PAGE_SIZE, offset: off, refine }));
    results = results.concat(page.results);
  }
  results.forEach(t => {
    t.departMin = hhmmToMin(t.heure_depart);
    let a = hhmmToMin(t.heure_arrivee);
    if (a < t.departMin) a += 1440;
    t.arriveMin = a;
  });
  dayCache.set(date, results);
  return results;
}

function dateRangeList(minStr, maxStr) {
  const out = [];
  let d = new Date(minStr + "T00:00:00Z");
  const end = new Date(maxStr + "T00:00:00Z");
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function dayIndex(dateStr) {
  return Math.round(Date.parse(dateStr + "T00:00:00Z") / 86400000);
}
function absoluteMinutes(dateStr, minutesInDay) {
  return dayIndex(dateStr) * 1440 + minutesInDay;
}
function lowerBound(sortedArr, target) {
  let lo = 0, hi = sortedArr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedArr[mid] < target) lo = mid + 1; else hi = mid; }
  return lo;
}
function timeMatchesWindows(hhmm, windows) {
  if (!windows || windows.length === 0) return true;
  return windows.some(w => (!w.from || hhmm >= w.from) && (!w.to || hhmm <= w.to));
}

const JSDAY_TO_KEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function weekdayKeyOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return JSDAY_TO_KEY[d.getDay()];
}
function matchesSchedule(dateStr, departHHMM, arriveHHMM, schedule) {
  if (!schedule) return true;
  const day = schedule[weekdayKeyOf(dateStr)];
  if (!day) return true;
  const depOk = timeMatchesWindows(departHHMM, day.dep);
  const arrOk = timeMatchesWindows(arriveHHMM, day.arr);
  return schedule.combine === "AND" ? (depOk && arrOk) : (depOk || arrOk);
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function notYetDeparted(dateStr, departHHMM) {
  if (dateStr !== todayStr()) return true;
  return departHHMM > nowHHMM();
}

// Exact port of the client's connection-finding algorithm (index.html) — keep in sync.
function findItineraries(trains, originSet, destSet, opts) {
  const { minSame, minCity, maxConn } = opts;
  const byOrigineIata = new Map();
  const byOrigineName = new Map();
  for (const t of trains) {
    if (!byOrigineIata.has(t.origine_iata)) byOrigineIata.set(t.origine_iata, []);
    byOrigineIata.get(t.origine_iata).push(t);
    if (!byOrigineName.has(t.origine)) byOrigineName.set(t.origine, []);
    byOrigineName.get(t.origine).push(t);
  }
  function candidatesFrom(leg) {
    const out = [];
    (byOrigineIata.get(leg.destination_iata) || []).forEach(t2 => {
      if (t2 === leg) return;
      const gap = t2.departMin - leg.arriveMin;
      if (gap >= minSame && gap <= maxConn) out.push(t2);
    });
    (byOrigineName.get(leg.destination) || []).forEach(t2 => {
      if (t2.origine_iata === leg.destination_iata) return;
      const gap = t2.departMin - leg.arriveMin;
      if (gap >= minCity && gap <= maxConn) out.push(t2);
    });
    return out;
  }
  const legsFromOrigin = trains.filter(t => originSet.has(t.origine_iata));
  const results = [];
  const seen = new Set();
  function tryAdd(legs) {
    const key = legs.map(t => t.date + "#" + t.train_no + "#" + t.origine_iata + "#" + t.destination_iata).join(">");
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ legs, depart: legs[0].departMin, arrive: legs[legs.length - 1].arriveMin, key });
  }
  for (const leg1 of legsFromOrigin) {
    if (destSet.has(leg1.destination_iata)) tryAdd([leg1]);
    const c1 = candidatesFrom(leg1);
    for (const leg2 of c1) {
      if (leg2.origine_iata === leg1.origine_iata) continue;
      if (destSet.has(leg2.destination_iata)) { tryAdd([leg1, leg2]); continue; }
      const c2 = candidatesFrom(leg2);
      for (const leg3 of c2) {
        if (leg3.origine_iata === leg1.origine_iata || leg3.origine_iata === leg2.origine_iata) continue;
        if (destSet.has(leg3.destination_iata)) tryAdd([leg1, leg2, leg3]);
      }
    }
  }
  results.sort((a, b) => (a.legs.length - b.legs.length) || ((a.arrive - a.depart) - (b.arrive - b.depart)) || (a.depart - b.depart));
  return results.slice(0, 300);
}

function describeDirect(t) {
  return `${t.heure_depart} ${t.origine} → ${t.heure_arrivee} ${t.destination} (n°${t.train_no})`;
}
function describeItinerary(it) {
  const first = it.legs[0], last = it.legs[it.legs.length - 1];
  const kind = it.legs.length === 1 ? "direct" : `${it.legs.length - 1} corr.`;
  return `${first.date} ${first.heure_depart} ${first.origine} → ${last.heure_arrivee} ${last.destination} (${kind})`;
}

async function checkDirectWatch(watch) {
  const c = watch.criteria;
  const originIatas = c.originIatas || [];
  if (originIatas.length === 0) return { entries: [] };
  const originSet = new Set(originIatas);
  const trains = await getDayTrains(c.date);
  const matches = trains
    .filter(t => originSet.has(t.origine_iata))
    .filter(t => timeMatchesWindows(t.heure_depart, c.depWindows) && timeMatchesWindows(t.heure_arrivee, c.arrWindows))
    .filter(t => notYetDeparted(t.date, t.heure_depart));
  const entries = matches.map(t => ({
    key: `${t.date}#${t.train_no}#${t.origine_iata}#${t.destination_iata}`,
    describe: describeDirect(t),
  }));
  return { entries };
}

async function checkConnectionsWatch(watch) {
  const c = watch.criteria;
  const originIatas = c.originIatas || [];
  const destIatas = c.destIatas || [];
  if (originIatas.length === 0 || destIatas.length === 0) return { entries: [] };
  const originSet = new Set(originIatas);
  const destSet = new Set(destIatas);
  const connOpts = { minSame: c.minSame || 0, minCity: c.minCity || 0, maxConn: c.maxConn || 180 };

  const outboundDates = dateRangeList(c.dateMin, c.dateMax).slice(0, MAX_RANGE_DAYS);
  const returnDates = c.returnEnabled ? dateRangeList(c.retDateMin, c.retDateMax).slice(0, MAX_RANGE_DAYS) : [];

  const inSchedule = it => matchesSchedule(it.legs[0].date, it.legs[0].heure_depart, it.legs[it.legs.length - 1].heure_arrivee, c.schedule);

  let outboundItins = [];
  for (const d of outboundDates) {
    outboundItins = outboundItins.concat(findItineraries(await getDayTrains(d), originSet, destSet, connOpts));
  }
  outboundItins = outboundItins
    .filter(inSchedule)
    .filter(it => notYetDeparted(it.legs[0].date, it.legs[0].heure_depart));

  if (c.returnEnabled) {
    let returnItins = [];
    for (const d of returnDates) {
      returnItins = returnItins.concat(findItineraries(await getDayTrains(d), destSet, originSet, connOpts));
    }
    returnItins = returnItins
      .filter(inSchedule)
      .filter(it => notYetDeparted(it.legs[0].date, it.legs[0].heure_depart));
    returnItins.forEach(r => { r.absDepart = absoluteMinutes(r.legs[0].date, r.legs[0].departMin); });
    returnItins.sort((a, b) => a.absDepart - b.absDepart);
    const returnDeparts = returnItins.map(r => r.absDepart);
    const minStay = c.minStay || 0;
    outboundItins = outboundItins.filter(o => {
      const last = o.legs[o.legs.length - 1];
      const absArrive = absoluteMinutes(last.date, last.arriveMin);
      return lowerBound(returnDeparts, absArrive + minStay) < returnDeparts.length;
    });
  }

  const entries = outboundItins.map(it => ({ key: it.key, describe: describeItinerary(it) }));
  return { entries };
}

async function workerFetch(path, opts = {}) {
  const r = await fetch(`${WORKER_URL}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), "X-Admin-Secret": ADMIN_SECRET },
  });
  if (!r.ok) throw new Error(`Worker ${path} -> ${r.status}`);
  return r.json();
}
function patchWatch(id, patch) {
  return workerFetch(`/admin/watches/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
}
function deleteWatchAdmin(id) {
  return workerFetch(`/admin/watches/${id}`, { method: "DELETE" });
}

async function main() {
  console.log(`--- TGVmax Radar: vérification des alertes (${new Date().toISOString()}) ---`);
  const { watches } = await workerFetch("/admin/watches");
  console.log(`${watches.length} alerte(s) à vérifier.`);
  if (watches.length === 0) return;

  for (const watch of watches) {
    const nowIso = new Date().toISOString();
    try {
      const { entries } = watch.criteria.type === "direct"
        ? await checkDirectWatch(watch)
        : await checkConnectionsWatch(watch);

      const notifiedSet = new Set(watch.notifiedKeys || []);
      const newEntries = entries.filter(e => !notifiedSet.has(e.key));
      console.log(`[${watch.id}] ${watch.label}: ${entries.length} correspondance(s), ${newEntries.length} nouvelle(s).`);

      if (newEntries.length > 0) {
        const body = `${watch.label} — ${newEntries.length} nouveau(x) trajet(s) TGVmax libre(s) (ex. ${newEntries[0].describe})`;
        try {
          await webpush.sendNotification(watch.subscription, JSON.stringify({
            title: "🚄 TGVmax Radar", body, url: APP_URL, tag: `watch-${watch.id}`,
          }));
          const updatedKeys = Array.from(new Set([...(watch.notifiedKeys || []), ...entries.map(e => e.key)])).slice(-MAX_NOTIFIED_KEYS);
          await patchWatch(watch.id, { notifiedKeys: updatedKeys, lastCheckedAt: nowIso, lastError: null });
        } catch (pushErr) {
          if (pushErr.statusCode === 404 || pushErr.statusCode === 410) {
            console.log(`[${watch.id}] Abonnement push expiré — suppression de l'alerte.`);
            await deleteWatchAdmin(watch.id);
          } else {
            console.error(`[${watch.id}] Échec d'envoi push:`, pushErr.message || pushErr);
            await patchWatch(watch.id, { lastCheckedAt: nowIso, lastError: String(pushErr.message || pushErr).slice(0, 300) });
          }
        }
      } else {
        await patchWatch(watch.id, { lastCheckedAt: nowIso, lastError: null });
      }
    } catch (e) {
      console.error(`[${watch.id}] Erreur:`, e.message || e);
      await patchWatch(watch.id, { lastCheckedAt: nowIso, lastError: String(e.message || e).slice(0, 300) }).catch(() => {});
    }
  }

  console.log(`Terminé. ${sncfRequestCount} requête(s) SNCF utilisée(s) sur ce run.`);
}

main().catch(e => {
  console.error("Erreur fatale:", e);
  process.exit(1);
});
