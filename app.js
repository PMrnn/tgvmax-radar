// TGVmax Radar — main app logic.
const API_URL = "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax/records";
const PAGE_SIZE = 100;
const MAX_PAGES_SAFETY = 60; // hard safety cap (~6000 rows) per day fetch
const MAX_RANGE_DAYS = 15;

// ---- Alerts backend (Cloudflare Worker: stores watches + push subscriptions) ----
const WORKER_URL = "https://tgvmax-radar-worker.tgvmax-radar-pmrnn.workers.dev";
const VAPID_PUBLIC_KEY = "BOzXYeh9JHB2mVWQ43SqFmN6etvxeyp_c-FSHQzoDnjl8xXyU4Tk9gxXpzbVLA-nbhfW_boSf8H6RMdfXLnFM9o";

function normalize(s){
  return (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function buildUrl(params){
  const usp = new URLSearchParams();
  for (const [k,v] of Object.entries(params)){
    if (Array.isArray(v)) v.forEach(x=>usp.append(k,x));
    else usp.append(k, v);
  }
  return API_URL + "?" + usp.toString();
}
async function fetchJSON(url){
  const r = await fetch(url);
  if (!r.ok){
    let body = "";
    try{ body = await r.text(); }catch(e){}
    throw new Error(`Erreur API SNCF (${r.status}) : ${body.slice(0,200)}`);
  }
  return r.json();
}

// ---- Station catalog (one row per physical station, city-grouped, with coordinates) ----
let stationsCatalog = null;
let stationsByIata = null;
// Single source of truth for cache-busting: bump this whenever data/stations.json's
// CONTENT changes. It drives both the localStorage cache key and the fetch URL's query
// param, so there's only one place to touch (no risk of the two invalidating separately).
const STATIONS_DATA_VERSION = "3";
async function getStationsCatalog(){
  if (stationsCatalog) return stationsCatalog;
  const cacheKey = `tgvmax_stations_catalog_v${STATIONS_DATA_VERSION}`;
  try{
    const raw = localStorage.getItem(cacheKey);
    if (raw){
      const obj = JSON.parse(raw);
      if (Date.now() - obj.ts < 7*24*3600*1000){
        stationsCatalog = obj.stations;
        stationsByIata = new Map(stationsCatalog.map(s=>[s.iata, s]));
        return stationsCatalog;
      }
    }
  }catch(e){}
  // ?v= busts both the browser's HTTP cache and the service worker's cache for this file.
  const list = await fetchJSON(`data/stations.json?v=${STATIONS_DATA_VERSION}`);
  stationsCatalog = list;
  stationsByIata = new Map(list.map(s=>[s.iata, s]));
  try{ localStorage.setItem(cacheKey, JSON.stringify({ts:Date.now(), stations:list})); }catch(e){}
  return stationsCatalog;
}

// ---- Day trains (TGVmax available only) ----
const dayCache = new Map();
async function getDayTrains(date){
  if (dayCache.has(date)) return dayCache.get(date);
  const refine = [`date:${date}`, `od_happy_card:OUI`];
  const first = await fetchJSON(buildUrl({limit:PAGE_SIZE, offset:0, refine}));
  let results = first.results.slice();
  const total = Math.min(first.total_count, PAGE_SIZE*MAX_PAGES_SAFETY);
  const offsets = [];
  for (let off = PAGE_SIZE; off < total; off += PAGE_SIZE) offsets.push(off);
  const pages = await Promise.all(offsets.map(off => fetchJSON(buildUrl({limit:PAGE_SIZE, offset:off, refine}))));
  pages.forEach(p => results = results.concat(p.results));
  results.forEach(t=>{
    t.departMin = hhmmToMin(t.heure_depart);
    let a = hhmmToMin(t.heure_arrivee);
    if (a < t.departMin) a += 1440;
    t.arriveMin = a;
  });
  dayCache.set(date, results);
  return results;
}

function hhmmToMin(hhmm){
  const [h,m] = hhmm.split(":").map(Number);
  return h*60+m;
}
function minToHHMM(min){
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min/60), m = min%60;
  return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0");
}
function durationLabel(mins){
  const h = Math.floor(mins/60), m = mins%60;
  return h>0 ? `${h}h${String(m).padStart(2,"0")}` : `${m}min`;
}
function dateRangeList(minStr, maxStr){
  const out = [];
  let d = new Date(minStr+"T00:00:00Z");
  const end = new Date(maxStr+"T00:00:00Z");
  while (d <= end){
    out.push(d.toISOString().slice(0,10));
    d.setUTCDate(d.getUTCDate()+1);
  }
  return out;
}
function dayIndex(dateStr){
  return Math.round(Date.parse(dateStr+"T00:00:00Z")/86400000);
}
function absoluteMinutes(dateStr, minutesInDay){
  return dayIndex(dateStr)*1440 + minutesInDay;
}
function lowerBound(sortedArr, target){
  let lo=0, hi=sortedArr.length;
  while (lo<hi){ const mid=(lo+hi)>>1; if (sortedArr[mid] < target) lo=mid+1; else hi=mid; }
  return lo;
}
const dateLabelFmt = new Intl.DateTimeFormat("fr-FR", {weekday:"short", day:"numeric", month:"short"});
function formatDateLabel(dateStr){
  const d = new Date(dateStr+"T00:00:00");
  return dateLabelFmt.format(d).replace(".", "");
}
function todayStr(){ return new Date().toISOString().slice(0,10); }
function nowHHMM(){
  const d = new Date();
  return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
}
// Only relevant for a same-day search: hide trains whose departure has already passed.
function notYetDeparted(dateStr, departHHMM){
  if (dateStr !== todayStr()) return true;
  return departHHMM > nowHHMM();
}

// hhmm is a plain "HH:MM" clock time (string compare works since always zero-padded).
// windows is an array of {from, to} (each optional "HH:MM"); matches if it falls in ANY window (OR).
// An empty windows array means "no constraint" (matches everything).
function timeMatchesWindows(hhmm, windows){
  if (!windows || windows.length === 0) return true;
  return windows.some(w => (!w.from || hhmm >= w.from) && (!w.to || hhmm <= w.to));
}

// Drop itineraries/trains that are strictly no-better than another one sharing the exact
// same departure instant: for a given departure, only the earliest-arriving option survives.
// extract(item) -> {date, departMin, arriveMin}
function pruneDominated(items, extract){
  const withAbs = items.map(it => {
    const {date, departMin, arriveMin} = extract(it);
    return {it, absDep: absoluteMinutes(date, departMin), absArr: absoluteMinutes(date, arriveMin)};
  });
  withAbs.sort((a,b)=> (a.absDep-b.absDep) || (a.absArr-b.absArr));
  const out = [];
  let lastDep = null;
  for (const w of withAbs){
    if (w.absDep === lastDep) continue; // a strictly-as-good-or-better option for this exact departure was already kept
    out.push(w.it);
    lastDep = w.absDep;
  }
  return out;
}

// ---- Weekly availability schedule (per-weekday time windows, used by Trajet A -> B) ----
const WEEKDAY_ORDER = ["mon","tue","wed","thu","fri","sat","sun"];
const WEEKDAY_LABELS = {mon:"Lundi",tue:"Mardi",wed:"Mercredi",thu:"Jeudi",fri:"Vendredi",sat:"Samedi",sun:"Dimanche"};
const WEEKEND_KEYS = new Set(["sat","sun"]);
const JSDAY_TO_KEY = ["sun","mon","tue","wed","thu","fri","sat"]; // Date.getDay(): 0 = Sunday
const SCHEDULE_STORAGE_KEY = "tgvmax_weekly_schedule_v1";

function defaultWeeklySchedule(){
  const s = { combine: "OR" };
  WEEKDAY_ORDER.forEach(day=>{
    s[day] = WEEKEND_KEYS.has(day)
      ? { dep: [], arr: [] }
      : { dep: [{from:"18:00", to:""}], arr: [{from:"", to:"09:00"}] };
  });
  return s;
}
function loadWeeklySchedule(){
  try{
    const raw = localStorage.getItem(SCHEDULE_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  }catch(e){}
  return defaultWeeklySchedule();
}
function saveWeeklySchedule(schedule){
  try{ localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(schedule)); }catch(e){}
}
function weekdayKeyOf(dateStr){
  const d = new Date(dateStr+"T00:00:00");
  return JSDAY_TO_KEY[d.getDay()];
}
function matchesSchedule(dateStr, departHHMM, arriveHHMM, schedule){
  const day = schedule[weekdayKeyOf(dateStr)];
  if (!day) return true;
  const depOk = timeMatchesWindows(departHHMM, day.dep);
  const arrOk = timeMatchesWindows(arriveHHMM, day.arr);
  return schedule.combine === "AND" ? (depOk && arrOk) : (depOk || arrOk);
}

function renderPlanGrid(schedule){
  const grid = document.getElementById("plan-grid");
  grid.innerHTML = WEEKDAY_ORDER.map(day => `
    <div class="plan-day" data-day="${day}">
      <div class="plan-day-head">${WEEKDAY_LABELS[day]} ${WEEKEND_KEYS.has(day)?'<span class="weekend-tag">week-end</span>':''}</div>
      <div class="plan-cols">
        <div class="plan-col">
          <div class="plan-col-label">Départ accepté</div>
          <div class="windows-list" id="plan-${day}-dep"></div>
          <button type="button" class="btn-add-window" data-target="plan-${day}-dep">+ fenêtre</button>
        </div>
        <div class="plan-col">
          <div class="plan-col-label">Arrivée acceptée</div>
          <div class="windows-list" id="plan-${day}-arr"></div>
          <button type="button" class="btn-add-window" data-target="plan-${day}-arr">+ fenêtre</button>
        </div>
      </div>
    </div>`).join("");
  WEEKDAY_ORDER.forEach(day=>{
    (schedule[day].dep||[]).forEach(w=> addWindowRow(`plan-${day}-dep`, w.from, w.to));
    (schedule[day].arr||[]).forEach(w=> addWindowRow(`plan-${day}-arr`, w.from, w.to));
  });
  document.getElementById("plan-combine-mode").value = schedule.combine || "OR";
}
function readScheduleFromUI(){
  const schedule = { combine: document.getElementById("plan-combine-mode").value };
  WEEKDAY_ORDER.forEach(day=>{
    schedule[day] = { dep: getWindows(`plan-${day}-dep`), arr: getWindows(`plan-${day}-arr`) };
  });
  return schedule;
}

// ---- Reusable "list of time windows" widget (add/remove rows, read back values) ----
function addWindowRow(containerId, from, to){
  const container = document.getElementById(containerId);
  if (!container) return;
  const row = document.createElement("div");
  row.className = "window-row";
  row.innerHTML = `<input type="time" class="win-from" value="${from||""}"><span>–</span><input type="time" class="win-to" value="${to||""}"><button type="button" class="win-remove" aria-label="Supprimer cette fenêtre">✕</button>`;
  row.querySelector(".win-remove").onclick = ()=> row.remove();
  container.appendChild(row);
}
function getWindows(containerId){
  const wins = [];
  const container = document.getElementById(containerId);
  if (!container) return wins;
  container.querySelectorAll(".window-row").forEach(row=>{
    const from = row.querySelector(".win-from").value;
    const to = row.querySelector(".win-to").value;
    if (from || to) wins.push({from, to});
  });
  return wins;
}
document.addEventListener("click", (e)=>{
  const btn = e.target.closest(".btn-add-window");
  if (btn) addWindowRow(btn.dataset.target);
});

// ---- Station picker: type to filter, stations grouped by city, explicit checkbox selection ----
const pickers = {};
function createPicker(rootId){
  const root = document.getElementById(rootId);
  const input = root.querySelector(".picker-input");
  const dropdown = root.querySelector(".picker-dropdown");
  const chipsEl = root.querySelector(".picker-chips");
  const selected = new Set(); // iata codes

  function renderChips(){
    chipsEl.innerHTML = Array.from(selected).map(iata=>{
      const st = stationsByIata.get(iata);
      const label = st ? st.label : iata;
      return `<span class="chip">${escapeHtml(label)} <button type="button" data-remove="${iata}">✕</button></span>`;
    }).join("");
    chipsEl.querySelectorAll("[data-remove]").forEach(btn=>{
      btn.onclick = ()=>{ selected.delete(btn.dataset.remove); renderChips(); renderDropdown(); };
    });
  }

  function renderDropdown(){
    const q = normalize(input.value);
    if (q.length < 2){ dropdown.hidden = true; dropdown.innerHTML=""; return; }
    const matches = stationsCatalog.filter(s => normalize(s.city).includes(q) || normalize(s.label).includes(q));
    if (matches.length === 0){
      dropdown.hidden = false;
      dropdown.innerHTML = '<div class="picker-empty">Aucune gare trouvée.</div>';
      return;
    }
    const byCity = new Map();
    matches.forEach(s=>{ if(!byCity.has(s.city)) byCity.set(s.city, []); byCity.get(s.city).push(s); });
    let html = "";
    for (const [city, stns] of byCity){
      const allChecked = stns.every(s=>selected.has(s.iata));
      html += `<div class="picker-group">
        <div class="picker-group-head">
          <span>${escapeHtml(city)}</span>
          <button type="button" class="picker-checkall" data-city="${escapeHtml(city)}">${allChecked?"tout décocher":"tout cocher"}</button>
        </div>`;
      stns.forEach(s=>{
        html += `<label class="picker-row">
          <input type="checkbox" data-iata="${s.iata}" ${selected.has(s.iata)?"checked":""}>
          ${escapeHtml(s.label)}
        </label>`;
      });
      html += `</div>`;
    }
    dropdown.innerHTML = html;
    dropdown.hidden = false;
    dropdown.querySelectorAll("[data-iata]").forEach(cb=>{
      cb.onchange = ()=>{ if(cb.checked) selected.add(cb.dataset.iata); else selected.delete(cb.dataset.iata); renderChips(); };
    });
    dropdown.querySelectorAll("[data-city]").forEach(btn=>{
      btn.onclick = ()=>{
        const city = btn.dataset.city;
        const stns = byCity.get(city);
        const allChecked = stns.every(s=>selected.has(s.iata));
        stns.forEach(s=> allChecked ? selected.delete(s.iata) : selected.add(s.iata));
        renderDropdown(); renderChips();
      };
    });
  }

  input.addEventListener("input", renderDropdown);
  input.addEventListener("focus", renderDropdown);
  document.addEventListener("click", (e)=>{ if (!root.contains(e.target)) dropdown.hidden = true; });

  return {
    getSelected: ()=> Array.from(selected),
    getSelectedLabels: ()=> Array.from(selected).map(i => (stationsByIata.get(i)||{}).label || i),
    setSelected: (iatas)=>{ selected.clear(); (iatas||[]).forEach(i=>selected.add(i)); renderChips(); },
  };
}

// ---- Tabs ----
const tabDirect = document.getElementById("tab-direct");
const tabConnect = document.getElementById("tab-connect");
const tabAlerts = document.getElementById("tab-alerts");
const panelDirect = document.getElementById("panel-direct");
const panelConnect = document.getElementById("panel-connect");
const panelAlerts = document.getElementById("panel-alerts");
const allTabs = [tabDirect, tabConnect, tabAlerts];
const allPanels = [panelDirect, panelConnect, panelAlerts];
function activateTab(tab, panel){
  allTabs.forEach(t=>t.classList.toggle("active", t===tab));
  allPanels.forEach(p=>p.hidden = (p!==panel));
}
tabDirect.onclick = ()=> activateTab(tabDirect, panelDirect);
tabConnect.onclick = ()=>{ activateTab(tabConnect, panelConnect); maybeAutoOpenPlanModal(); };
tabAlerts.onclick = ()=>{ activateTab(tabAlerts, panelAlerts); loadAlerts(); };

// ---- Init: dates, pickers, weekly plan, return-date auto-bump ----
const today = todayStr();
document.getElementById("d-date").value = today;
document.getElementById("d-date").min = today;
["c-date-min","c-date-max","c-ret-date-min","c-ret-date-max"].forEach(id=>{
  const el = document.getElementById(id);
  el.value = today;
  el.min = today;
});

const returnToggle = document.getElementById("c-return-toggle");
const returnFields = document.getElementById("c-return-fields");
const minStayField = document.getElementById("c-min-stay-field");
returnToggle.onchange = ()=>{
  returnFields.hidden = !returnToggle.checked;
  minStayField.hidden = !returnToggle.checked;
};

// Keeps the retour dates from ever being scheduled before the aller: whenever either
// aller date changes, the retour "du" (and, transitively, "au") snap forward to the
// latest possible aller day (dateMax) if they'd otherwise precede it.
function bumpReturnDates(){
  const dateMaxEl = document.getElementById("c-date-max");
  const retMinEl = document.getElementById("c-ret-date-min");
  const retMaxEl = document.getElementById("c-ret-date-max");
  if (!dateMaxEl.value) return;
  retMinEl.min = dateMaxEl.value;
  if (!retMinEl.value || retMinEl.value < dateMaxEl.value) retMinEl.value = dateMaxEl.value;
  retMaxEl.min = retMinEl.value;
  if (!retMaxEl.value || retMaxEl.value < retMinEl.value) retMaxEl.value = retMinEl.value;
}
["c-date-min","c-date-max"].forEach(id=>{
  const el = document.getElementById(id);
  el.addEventListener("change", bumpReturnDates);
  el.addEventListener("input", bumpReturnDates);
});
document.getElementById("c-ret-date-min").addEventListener("change", ()=>{
  const retMinEl = document.getElementById("c-ret-date-min");
  const retMaxEl = document.getElementById("c-ret-date-max");
  retMaxEl.min = retMinEl.value;
  if (retMaxEl.value < retMinEl.value) retMaxEl.value = retMinEl.value;
});
bumpReturnDates();

function summarizeSchedule(schedule){
  const weekdays = WEEKDAY_ORDER.filter(d=>!WEEKEND_KEYS.has(d));
  const weekends = WEEKDAY_ORDER.filter(d=>WEEKEND_KEYS.has(d));
  const sameJSON = (a,b)=> JSON.stringify(a)===JSON.stringify(b);
  const wdRef = schedule[weekdays[0]];
  const weekdaysUniform = weekdays.every(d=> sameJSON(schedule[d], wdRef));
  const weRef = schedule[weekends[0]];
  const weekendUniform = weekends.every(d=> sameJSON(schedule[d], weRef));
  const combineLabel = schedule.combine === "AND" ? "et" : "ou";
  function describeDay(day){
    const depEmpty = !day.dep || day.dep.length===0;
    const arrEmpty = !day.arr || day.arr.length===0;
    if (depEmpty && arrEmpty) return "toute heure";
    const parts = [];
    if (!depEmpty) parts.push("départ " + formatWindowsSummary(day.dep));
    if (!arrEmpty) parts.push("arrivée " + formatWindowsSummary(day.arr));
    return parts.join(` ${combineLabel} `);
  }
  if (weekdaysUniform && weekendUniform){
    return `Semaine : ${describeDay(wdRef)} · Week-end : ${describeDay(weRef)}`;
  }
  return "Disponibilités personnalisées par jour — cliquez sur Modifier pour le détail.";
}
function updatePlanSummary(schedule){
  document.getElementById("plan-summary-text").textContent = summarizeSchedule(schedule);
}

const planModal = document.getElementById("plan-modal");
function openPlanModal(){ planModal.hidden = false; }
function closePlanModal(){
  const schedule = readScheduleFromUI();
  saveWeeklySchedule(schedule);
  updatePlanSummary(schedule);
  planModal.hidden = true;
}
document.getElementById("plan-open").onclick = openPlanModal;
document.getElementById("plan-modal-close").onclick = closePlanModal;
document.getElementById("plan-done").onclick = closePlanModal;
planModal.addEventListener("click", (e)=>{ if (e.target === planModal) closePlanModal(); });
document.addEventListener("keydown", (e)=>{ if (e.key === "Escape" && !planModal.hidden) closePlanModal(); });

{
  const initialSchedule = loadWeeklySchedule();
  renderPlanGrid(initialSchedule);
  updatePlanSummary(initialSchedule);
}
document.getElementById("plan-reset").onclick = ()=>{
  const def = defaultWeeklySchedule();
  renderPlanGrid(def);
  saveWeeklySchedule(def);
  updatePlanSummary(def);
};

// Ask for availability once, the first time the connections tab is opened.
const PLAN_SEEN_KEY = "tgvmax_plan_seen";
function maybeAutoOpenPlanModal(){
  if (!localStorage.getItem(PLAN_SEEN_KEY)){
    openPlanModal();
    try{ localStorage.setItem(PLAN_SEEN_KEY, "1"); }catch(e){}
  }
}

getStationsCatalog().then(()=>{
  pickers.dOrigin = createPicker("d-origin-picker");
  pickers.cOrigin = createPicker("c-origin-picker");
  pickers.cDest = createPicker("c-dest-picker");
}).catch(e=>console.warn("Impossible de charger le catalogue des gares :", e));

// ---- Feature 1: direct free trains from a departure town ----
document.getElementById("d-search").onclick = async ()=>{
  const date = document.getElementById("d-date").value;
  const depWindows = getWindows("d-dep-windows");
  const arrWindows = getWindows("d-arr-windows");
  const statusEl = document.getElementById("d-status");
  const resultsEl = document.getElementById("d-results");
  resultsEl.innerHTML = "";
  const originIatas = pickers.dOrigin.getSelected();
  if (originIatas.length === 0 || !date){
    statusEl.innerHTML = '<span class="err">Merci de sélectionner au moins une gare de départ et une date.</span>';
    return;
  }

  statusEl.innerHTML = '<span class="spinner"></span>Recherche en cours…';
  try{
    const originSet = new Set(originIatas);
    const trains = await getDayTrains(date);
    let matches = trains
      .filter(t => originSet.has(t.origine_iata))
      .filter(t => timeMatchesWindows(t.heure_depart, depWindows) && timeMatchesWindows(t.heure_arrivee, arrWindows))
      .filter(t => notYetDeparted(t.date, t.heure_depart));
    matches = pruneDominated(matches, t => ({date:t.date, departMin:t.departMin, arriveMin:t.arriveMin}))
      .sort((a,b)=>a.departMin-b.departMin);

    const originLabels = pickers.dOrigin.getSelectedLabels();
    statusEl.textContent = `${matches.length} train(s) TGVmax libre(s) le ${date} depuis : ${originLabels.join(", ")}.`;

    if (matches.length === 0){
      resultsEl.innerHTML = '<div class="empty">Aucun train avec place TGVmax libre trouvé pour ces critères. Essayez d’élargir la fenêtre horaire.</div>';
      return;
    }
    let html = '<table><thead><tr><th>Départ</th><th>Arrivée</th><th>Destination</th><th>Durée</th><th>Train</th><th></th></tr></thead><tbody>';
    for (const t of matches){
      html += `<tr class="train-row" data-origin-iata="${t.origine_iata}" data-dest-iata="${t.destination_iata}">
        <td>${t.heure_depart}<br><span style="color:var(--muted);font-size:11.5px;">${t.origine}</span></td>
        <td>${t.heure_arrivee}</td>
        <td>${t.destination}</td>
        <td>${durationLabel(t.arriveMin - t.departMin)}</td>
        <td style="color:var(--muted);">n°${t.train_no}${t.axe ? " · "+t.axe : ""}</td>
        <td><span class="pill">TGVmax libre</span></td>
      </tr>`;
    }
    html += "</tbody></table>";
    resultsEl.innerHTML = html;
    wireTrainRowMaps(resultsEl);
  }catch(e){
    console.error(e);
    statusEl.innerHTML = `<span class="err">Erreur : ${escapeHtml(e.message||String(e))}</span>`;
  }
};

document.getElementById("d-alert-btn").onclick = async ()=>{
  const date = document.getElementById("d-date").value;
  const depWindows = getWindows("d-dep-windows");
  const arrWindows = getWindows("d-arr-windows");
  const statusEl = document.getElementById("d-status");
  const originIatas = pickers.dOrigin.getSelected();
  if (originIatas.length === 0 || !date){
    statusEl.innerHTML = '<span class="err">Merci de sélectionner au moins une gare de départ et une date avant de créer une alerte.</span>';
    return;
  }
  const criteria = { type: "direct", originIatas, date, depWindows, arrWindows };
  const label = `Départ ${pickers.dOrigin.getSelectedLabels().join(", ")} — ${date}`;
  statusEl.innerHTML = '<span class="spinner"></span>Création de l’alerte…';
  try{
    await createWatch(criteria, label);
    statusEl.innerHTML = `<span class="pill">🔔 Alerte créée</span> — consultez l’onglet « Mes alertes ».`;
  }catch(e){
    console.error(e);
    statusEl.innerHTML = `<span class="err">Erreur : ${escapeHtml(e.message||String(e))}</span>`;
  }
};

// ---- Journey map (click a train row in Feature 1) ----
function wireTrainRowMaps(container){
  container.querySelectorAll("tr.train-row").forEach(tr=>{
    tr.onclick = ()=>{
      const next = tr.nextElementSibling;
      if (next && next.classList.contains("map-row")){ next.remove(); return; }
      container.querySelectorAll(".map-row").forEach(r=>r.remove());
      const mapRow = document.createElement("tr");
      mapRow.className = "map-row";
      const td = document.createElement("td");
      td.colSpan = 6;
      mapRow.appendChild(td);
      tr.after(mapRow);
      renderJourneyMap(td, tr.dataset.originIata, tr.dataset.destIata);
    };
  });
}
function renderJourneyMap(container, originIata, destIata){
  const o = stationsByIata.get(originIata);
  const d = stationsByIata.get(destIata);
  if (!o || !d || o.lat==null || d.lat==null){
    container.innerHTML = '<div class="map-unavailable">🗺️ Carte indisponible pour cette gare (coordonnées manquantes dans le référentiel SNCF).</div>';
    return;
  }
  const mapDiv = document.createElement("div");
  mapDiv.className = "map-box";
  container.innerHTML = "";
  container.appendChild(mapDiv);
  const map = L.map(mapDiv, {scrollWheelZoom:false});
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
  const oLatLng = [o.lat, o.lon], dLatLng = [d.lat, d.lon];
  L.marker(oLatLng).addTo(map).bindPopup(o.label);
  L.marker(dLatLng).addTo(map).bindPopup(d.label);
  const line = L.polyline([oLatLng, dLatLng], {color:"#8b1538", weight:3, dashArray:"6 6"}).addTo(map);
  map.fitBounds(line.getBounds(), {padding:[30,30]});
}

// ---- Feature 2: connections search (max 3 legs), over a date range, optional return, weekly schedule ----
document.getElementById("c-search").onclick = async ()=>{
  const dateMin = document.getElementById("c-date-min").value;
  const dateMax = document.getElementById("c-date-max").value;
  const returnEnabled = document.getElementById("c-return-toggle").checked;
  const retDateMin = document.getElementById("c-ret-date-min").value;
  const retDateMax = document.getElementById("c-ret-date-max").value;
  const minSame = Number(document.getElementById("c-min-same").value)||0;
  const minCity = Number(document.getElementById("c-min-city").value)||0;
  const maxConn = Number(document.getElementById("c-max").value)||180;
  const minStay = Number(document.getElementById("c-min-stay").value)||0;
  const schedule = readScheduleFromUI();
  saveWeeklySchedule(schedule);
  const statusEl = document.getElementById("c-status");
  const resultsEl = document.getElementById("c-results");
  resultsEl.innerHTML = "";

  const originIatas = pickers.cOrigin.getSelected();
  const destIatas = pickers.cDest.getSelected();
  if (originIatas.length === 0 || destIatas.length === 0 || !dateMin || !dateMax){
    statusEl.innerHTML = '<span class="err">Merci de sélectionner un départ, une arrivée et une plage de dates aller.</span>';
    return;
  }
  if (dateMin > dateMax){
    statusEl.innerHTML = '<span class="err">La date aller « du » doit être avant ou égale à la date « au ».</span>';
    return;
  }
  if (returnEnabled){
    if (!retDateMin || !retDateMax){
      statusEl.innerHTML = '<span class="err">Merci de renseigner une plage de dates retour.</span>';
      return;
    }
    if (retDateMin > retDateMax){
      statusEl.innerHTML = '<span class="err">La date retour « du » doit être avant ou égale à la date « au ».</span>';
      return;
    }
  }

  const outboundDates = dateRangeList(dateMin, dateMax);
  const returnDates = returnEnabled ? dateRangeList(retDateMin, retDateMax) : [];
  if (outboundDates.length > MAX_RANGE_DAYS){
    statusEl.innerHTML = `<span class="err">Plage de dates aller trop large (${outboundDates.length} jours) — réduisez à ${MAX_RANGE_DAYS} jours maximum.</span>`;
    return;
  }
  if (returnDates.length > MAX_RANGE_DAYS){
    statusEl.innerHTML = `<span class="err">Plage de dates retour trop large (${returnDates.length} jours) — réduisez à ${MAX_RANGE_DAYS} jours maximum.</span>`;
    return;
  }

  statusEl.innerHTML = '<span class="spinner"></span>Recherche en cours (jusqu’à 3 trains, plusieurs dates)…';
  try{
    const originSet = new Set(originIatas);
    const destSet = new Set(destIatas);
    const connOpts = {minSame, minCity, maxConn};

    const allDates = Array.from(new Set([...outboundDates, ...returnDates]));
    await Promise.all(allDates.map(d => getDayTrains(d)));

    const inSchedule = it => matchesSchedule(it.legs[0].date, it.legs[0].heure_depart, it.legs[it.legs.length-1].heure_arrivee, schedule);

    let outboundItins = [];
    for (const d of outboundDates){
      outboundItins = outboundItins.concat(findItineraries(dayCache.get(d), originSet, destSet, connOpts));
    }
    outboundItins = outboundItins
      .filter(inSchedule)
      .filter(it => notYetDeparted(it.legs[0].date, it.legs[0].heure_depart));

    let returnItins = [];
    if (returnEnabled){
      for (const d of returnDates){
        returnItins = returnItins.concat(findItineraries(dayCache.get(d), destSet, originSet, connOpts));
      }
      returnItins = returnItins
        .filter(inSchedule)
        .filter(it => notYetDeparted(it.legs[0].date, it.legs[0].heure_depart));
      returnItins = pruneDominated(returnItins, it => ({date:it.legs[0].date, departMin:it.legs[0].departMin, arriveMin:it.legs[it.legs.length-1].arriveMin}));
      returnItins.forEach(r => { r.absDepart = absoluteMinutes(r.legs[0].date, r.legs[0].departMin); });
      returnItins.sort((a,b)=>a.absDepart-b.absDepart);
      const returnDeparts = returnItins.map(r=>r.absDepart);

      outboundItins.forEach(o => {
        o.absArrive = absoluteMinutes(o.legs[o.legs.length-1].date, o.legs[o.legs.length-1].arriveMin);
      });
      outboundItins = outboundItins.filter(o => {
        const idx = lowerBound(returnDeparts, o.absArrive + minStay);
        const matches = returnItins.slice(idx);
        o.compatibleReturnsTotal = matches.length;
        o.compatibleReturns = matches.slice(0, 5);
        return matches.length > 0;
      });
    }

    outboundItins = pruneDominated(outboundItins, it => ({date: it.legs[0].date, departMin: it.legs[0].departMin, arriveMin: it.legs[it.legs.length-1].arriveMin}));
    outboundItins.forEach(o => { o.absDepart = absoluteMinutes(o.legs[0].date, o.legs[0].departMin); });
    outboundItins.sort((a,b)=> (a.legs.length-b.legs.length) || (a.absDepart-b.absDepart));

    const originLabels = pickers.cOrigin.getSelectedLabels();
    const destLabels = pickers.cDest.getSelectedLabels();
    const rangeLabel = dateMin===dateMax ? `le ${dateMin}` : `entre le ${dateMin} et le ${dateMax}`;
    const retRangeLabel = returnEnabled ? (retDateMin===retDateMax ? `le ${retDateMin}` : `entre le ${retDateMin} et le ${retDateMax}`) : "";
    statusEl.textContent = returnEnabled
      ? `${outboundItins.length} aller(s) 100% TGVmax avec un retour compatible trouvé(s) (aller ${rangeLabel}, retour ${retRangeLabel}) : ${originLabels.join(", ")} → ${destLabels.join(", ")}.`
      : `${outboundItins.length} itinéraire(s) 100% TGVmax trouvé(s) ${rangeLabel} : ${originLabels.join(", ")} → ${destLabels.join(", ")}.`;

    if (outboundItins.length === 0){
      resultsEl.innerHTML = returnEnabled
        ? '<div class="empty">Aucun aller avec un retour compatible trouvé pour ces critères. Essayez d’élargir les plages de dates, vos disponibilités, ou de réduire le temps mini sur place.</div>'
        : '<div class="empty">Aucun itinéraire entièrement en places TGVmax libres trouvé (direct, 1 ou 2 correspondances) pour ces critères. Essayez d’élargir la plage de dates ou vos disponibilités.</div>';
      return;
    }

    const byLegs = {1:[], 2:[], 3:[]};
    outboundItins.forEach(it => byLegs[it.legs.length].push(it));

    let html = "";
    const titles = {1:"Trajets directs", 2:"1 correspondance", 3:"2 correspondances"};
    for (const n of [1,2,3]){
      const group = byLegs[n];
      if (group.length === 0) continue;
      html += `<div class="section-title">${titles[n]} (${group.length})</div>`;
      group.slice(0,25).forEach(it => { html += renderItinerary(it, {showDate: outboundDates.length>1, returnBlock: returnEnabled}); });
    }
    resultsEl.innerHTML = html;
  }catch(e){
    console.error(e);
    statusEl.innerHTML = `<span class="err">Erreur : ${escapeHtml(e.message||String(e))}</span>`;
  }
};

document.getElementById("c-alert-btn").onclick = async ()=>{
  const dateMin = document.getElementById("c-date-min").value;
  const dateMax = document.getElementById("c-date-max").value;
  const returnEnabled = document.getElementById("c-return-toggle").checked;
  const retDateMin = document.getElementById("c-ret-date-min").value;
  const retDateMax = document.getElementById("c-ret-date-max").value;
  const minSame = Number(document.getElementById("c-min-same").value)||0;
  const minCity = Number(document.getElementById("c-min-city").value)||0;
  const maxConn = Number(document.getElementById("c-max").value)||180;
  const minStay = Number(document.getElementById("c-min-stay").value)||0;
  const schedule = readScheduleFromUI();
  saveWeeklySchedule(schedule);
  const statusEl = document.getElementById("c-status");

  const originIatas = pickers.cOrigin.getSelected();
  const destIatas = pickers.cDest.getSelected();
  if (originIatas.length === 0 || destIatas.length === 0 || !dateMin || !dateMax){
    statusEl.innerHTML = '<span class="err">Merci de sélectionner un départ, une arrivée et une plage de dates avant de créer une alerte.</span>';
    return;
  }
  if (returnEnabled && (!retDateMin || !retDateMax)){
    statusEl.innerHTML = '<span class="err">Merci de renseigner une plage de dates retour avant de créer une alerte.</span>';
    return;
  }

  const criteria = {
    type: "connections", originIatas, destIatas, dateMin, dateMax,
    returnEnabled, retDateMin, retDateMax, minSame, minCity, maxConn, minStay,
    schedule,
  };
  const originLabels = pickers.cOrigin.getSelectedLabels();
  const destLabels = pickers.cDest.getSelectedLabels();
  let label = `${originLabels.join("/")} → ${destLabels.join("/")} (${dateMin}${dateMin!==dateMax?" au "+dateMax:""})`;
  if (returnEnabled) label += ` + retour (${retDateMin}${retDateMin!==retDateMax?" au "+retDateMax:""})`;

  statusEl.innerHTML = '<span class="spinner"></span>Création de l’alerte…';
  try{
    await createWatch(criteria, label);
    statusEl.innerHTML = `<span class="pill">🔔 Alerte créée</span> — consultez l’onglet « Mes alertes ».`;
  }catch(e){
    console.error(e);
    statusEl.innerHTML = `<span class="err">Erreur : ${escapeHtml(e.message||String(e))}</span>`;
  }
};

function findItineraries(trains, originSet, destSet, opts){
  const {minSame, minCity, maxConn} = opts;

  const byOrigineIata = new Map();
  const byOrigineName = new Map();
  for (const t of trains){
    if (!byOrigineIata.has(t.origine_iata)) byOrigineIata.set(t.origine_iata, []);
    byOrigineIata.get(t.origine_iata).push(t);
    if (!byOrigineName.has(t.origine)) byOrigineName.set(t.origine, []);
    byOrigineName.get(t.origine).push(t);
  }

  function candidatesFrom(leg){
    const out = [];
    (byOrigineIata.get(leg.destination_iata)||[]).forEach(t2=>{
      if (t2 === leg) return;
      const gap = t2.departMin - leg.arriveMin;
      if (gap >= minSame && gap <= maxConn) out.push(t2);
    });
    (byOrigineName.get(leg.destination)||[]).forEach(t2=>{
      if (t2.origine_iata === leg.destination_iata) return; // already covered (same physical station)
      const gap = t2.departMin - leg.arriveMin;
      if (gap >= minCity && gap <= maxConn) out.push(t2);
    });
    return out;
  }

  const legsFromOrigin = trains.filter(t => originSet.has(t.origine_iata));
  const results = [];
  const seen = new Set();

  function tryAdd(legs){
    const key = legs.map(t=>t.date+"#"+t.train_no+"#"+t.origine_iata+"#"+t.destination_iata).join(">");
    if (seen.has(key)) return;
    seen.add(key);
    results.push({legs, depart:legs[0].departMin, arrive:legs[legs.length-1].arriveMin, key});
  }

  for (const leg1 of legsFromOrigin){
    if (destSet.has(leg1.destination_iata)){
      tryAdd([leg1]);
    }
    const c1 = candidatesFrom(leg1);
    for (const leg2 of c1){
      if (leg2.origine_iata === leg1.origine_iata) continue;
      if (destSet.has(leg2.destination_iata)){
        tryAdd([leg1, leg2]);
        continue;
      }
      const c2 = candidatesFrom(leg2);
      for (const leg3 of c2){
        if (leg3.origine_iata === leg1.origine_iata || leg3.origine_iata === leg2.origine_iata) continue;
        if (destSet.has(leg3.destination_iata)){
          tryAdd([leg1, leg2, leg3]);
        }
      }
    }
  }

  results.sort((a,b)=> (a.legs.length - b.legs.length) || ((a.arrive-a.depart) - (b.arrive-b.depart)) || (a.depart-b.depart));
  return results.slice(0, 300); // safety cap before grouping/rendering
}

function renderItinerary(it, opts){
  opts = opts || {};
  const total = it.arrive - it.depart;
  const compactClass = opts.compact ? " compact" : "";
  let html = `<div class="itin${compactClass}">`;
  if (opts.showDate){
    html += `<div class="date-badge">${formatDateLabel(it.legs[0].date)}</div>`;
  }
  html += `<div class="itin-head">
    <div>${it.legs[0].heure_depart} → ${it.legs[it.legs.length-1].heure_arrivee} <span style="color:var(--muted);font-weight:400;">(${durationLabel(total)})</span></div>
    <div class="legs-count">${it.legs.length===1?"Direct":it.legs.length-1+" correspondance"+(it.legs.length>2?"s":"")}</div>
  </div>`;
  it.legs.forEach((leg, i)=>{
    if (i>0){
      const prev = it.legs[i-1];
      const gap = leg.departMin - prev.arriveMin;
      const sameStation = leg.origine_iata === prev.destination_iata;
      html += `<div class="connect">⏱ correspondance ${durationLabel(gap)}${sameStation ? "" : " · changement de gare à "+leg.origine}</div>`;
    }
    html += `<div class="leg">
      <span class="time">${leg.heure_depart}</span>
      <span>${leg.origine}</span>
      <span class="arrow">→</span>
      <span class="time">${leg.heure_arrivee}</span>
      <span>${leg.destination}</span>
      <span class="train">n°${leg.train_no}${leg.axe?" · "+leg.axe:""} <span class="pill">TGVmax</span></span>
    </div>`;
  });

  if (opts.returnBlock && it.compatibleReturns){
    html += `<div class="return-block"><div class="return-label">🔁 Retour${it.compatibleReturnsTotal>1?"s":""} compatible${it.compatibleReturnsTotal>1?"s":""} (${it.compatibleReturnsTotal})</div>`;
    it.compatibleReturns.forEach(r => { html += renderItinerary(r, {showDate:true, compact:true}); });
    if (it.compatibleReturnsTotal > it.compatibleReturns.length){
      html += `<div class="more-note">+ ${it.compatibleReturnsTotal - it.compatibleReturns.length} autre(s) retour(s) possible(s)</div>`;
    }
    html += `</div>`;
  }

  html += "</div>";
  return html;
}

// ---- Alerts backend helpers ----
function getDeviceId(){
  let id = localStorage.getItem("tgvmax_device_id");
  if (!id){
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem("tgvmax_device_id", id);
  }
  return id;
}
function urlBase64ToUint8Array(base64String){
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i=0;i<raw.length;i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function ensurePushSubscription(){
  if (!("serviceWorker" in navigator) || !("PushManager" in window)){
    throw new Error("Les notifications push ne sont pas supportées par ce navigateur.");
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub){
    const perm = await Notification.requestPermission();
    if (perm !== "granted"){
      throw new Error("Permission de notification refusée. Autorisez les notifications pour créer une alerte.");
    }
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  return sub.toJSON();
}
async function createWatch(criteria, label){
  const subscription = await ensurePushSubscription();
  const r = await fetch(`${WORKER_URL}/watches`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ deviceId: getDeviceId(), subscription, criteria, label }),
  });
  if (!r.ok){
    const body = await r.text().catch(()=> "");
    throw new Error(`Erreur serveur alertes (${r.status}) : ${body.slice(0,200)}`);
  }
  return r.json();
}

function formatWindowsSummary(windows){
  if (!windows || windows.length===0) return "toute heure";
  return windows.map(w => {
    if (w.from && w.to) return `${w.from}–${w.to}`;
    if (w.from) return `après ${w.from}`;
    if (w.to) return `avant ${w.to}`;
    return "toute heure";
  }).join(" ou ");
}
function formatCriteriaSummary(c){
  if (c.type === "direct"){
    return `Départ le ${c.date} · départ ${formatWindowsSummary(c.depWindows)} · arrivée ${formatWindowsSummary(c.arrWindows)}`;
  }
  let s = c.dateMin===c.dateMax ? `Aller le ${c.dateMin}` : `Aller entre le ${c.dateMin} et le ${c.dateMax}`;
  if (c.returnEnabled) s += c.retDateMin===c.retDateMax ? ` · retour le ${c.retDateMin}` : ` · retour entre le ${c.retDateMin} et le ${c.retDateMax}`;
  s += ` · disponibilités hebdomadaires personnalisées`;
  return s;
}

async function loadAlerts(){
  const statusEl = document.getElementById("alerts-status");
  const listEl = document.getElementById("alerts-list");
  statusEl.innerHTML = '<span class="spinner"></span>Chargement…';
  try{
    const r = await fetch(`${WORKER_URL}/watches?deviceId=${encodeURIComponent(getDeviceId())}`);
    if (!r.ok) throw new Error(`Erreur serveur (${r.status})`);
    const { watches } = await r.json();
    statusEl.textContent = `${watches.length} alerte(s) active(s) sur cet appareil.`;
    if (watches.length === 0){
      listEl.innerHTML = '<div class="empty">Aucune alerte pour l’instant. Créez-en une depuis les onglets de recherche.</div>';
      return;
    }
    watches.sort((a,b)=> (b.createdAt||"").localeCompare(a.createdAt||""));
    listEl.innerHTML = watches.map(w => `
      <div class="watch-card">
        <div class="watch-head">
          <div>
            <div class="watch-label">${escapeHtml(w.label || "Alerte")}</div>
            <div class="watch-meta">${escapeHtml(formatCriteriaSummary(w.criteria))}</div>
            <div class="watch-meta">${w.lastCheckedAt ? "Dernière vérification : "+new Date(w.lastCheckedAt).toLocaleString("fr-FR") : "Pas encore vérifiée"}${w.lastError ? " · ⚠️ "+escapeHtml(w.lastError) : ""}</div>
          </div>
          <button class="btn-del" data-del="${w.id}">Supprimer</button>
        </div>
      </div>`).join("");
    listEl.querySelectorAll("[data-del]").forEach(btn=>{
      btn.onclick = ()=> deleteWatch(btn.dataset.del);
    });
  }catch(e){
    console.error(e);
    statusEl.innerHTML = `<span class="err">Erreur : ${escapeHtml(e.message||String(e))}</span>`;
  }
}
async function deleteWatch(id){
  const statusEl = document.getElementById("alerts-status");
  try{
    const r = await fetch(`${WORKER_URL}/watches/${encodeURIComponent(id)}?deviceId=${encodeURIComponent(getDeviceId())}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`Erreur serveur (${r.status})`);
    await loadAlerts();
  }catch(e){
    console.error(e);
    statusEl.innerHTML = `<span class="err">Erreur lors de la suppression : ${escapeHtml(e.message||String(e))}</span>`;
  }
}

// ---- PWA: register service worker (app-shell offline cache; API calls always live) ----
if ("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("sw.js").catch(e=>console.warn("SW registration failed:", e));
  });
}
