// ============================================================
// TERROIR INTELLIGENCE — LIVE WEATHER ENGINE
// ============================================================
// Auto-populates region climate data from Open-Meteo.
// No API key. CORS-enabled. Runs fully in the browser.
//
// Data source: Open-Meteo (aggregates NOAA, ECMWF, Météo-France,
// DWD, BOM, JMA, and other national weather services).
//
// ⚠ LICENSING: Open-Meteo is FREE FOR NON-COMMERCIAL USE under
// CC BY 4.0. For any PAID product (paid newsletter, B2B reports,
// white-label), you must use Open-Meteo's commercial plan OR
// self-host their open-source server. See:
//   https://open-meteo.com/en/pricing
//   https://github.com/open-meteo/open-meteo  (self-host, AGPL)
// Attribution required either way: "Weather data by Open-Meteo.com"
// ============================================================

const WEATHER = (function () {
  "use strict";

  const ARCHIVE_HOST  = "https://archive-api.open-meteo.com/v1/archive";
  const FORECAST_HOST = "https://api.open-meteo.com/v1/forecast";
  const SEASONAL_HOST = "https://seasonal-api.open-meteo.com/v1/seasonal";

  const BASE_TEMP_F = 50;          // GDD base temperature (°F) — standard for viticulture
  const HISTORY_YEARS = 10;        // years of archive used for the baseline
  const CACHE = {};                // in-memory cache: region.id -> {data, ts}
  const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

  // ----------------------------------------------------------
  // GROWING SEASON WINDOWS
  // Northern hemisphere: Apr 1 – Oct 31 (months 4–10)
  // Southern hemisphere: Oct 1 – Apr 30 (wraps the year)
  // ----------------------------------------------------------
  function isSouthern(lat) { return lat < 0; }

  function seasonWindow(lat, refDate) {
    const d = refDate || new Date();
    const year = d.getFullYear();
    if (isSouthern(lat)) {
      // Season started Oct 1 of previous (or current) year, ends Apr 30
      const month = d.getMonth(); // 0-based
      // If we're Jan–Apr, season started Oct 1 prior year.
      // If we're Oct–Dec, season started Oct 1 this year.
      const startYear = (month <= 3) ? year - 1 : year;
      return {
        start: new Date(startYear, 9, 1),       // Oct 1
        seasonEnd: new Date(startYear + 1, 3, 30), // Apr 30
        hemisphere: "Southern",
        harvestMonths: [2, 3, 4]                 // Mar–May harvest (S. hem)
      };
    }
    return {
      start: new Date(year, 3, 1),              // Apr 1
      seasonEnd: new Date(year, 9, 31),         // Oct 31
      hemisphere: "Northern",
      harvestMonths: [8, 9, 10]                  // Sep–Nov harvest (N. hem)
    };
  }

  function fmtDate(d) {
    return d.toISOString().slice(0, 10);
  }

  // ----------------------------------------------------------
  // GDD COMPUTATION (Fahrenheit base 50)
  // For each day: max(0, (Tmax+Tmin)/2 - 50), summed.
  // ----------------------------------------------------------
  function computeGDD(tmaxArr, tminArr) {
    let sum = 0;
    for (let i = 0; i < tmaxArr.length; i++) {
      const tmax = tmaxArr[i], tmin = tminArr[i];
      if (tmax == null || tmin == null) continue;
      const mean = (tmax + tmin) / 2;
      const gdd = Math.max(0, mean - BASE_TEMP_F);
      sum += gdd;
    }
    return Math.round(sum);
  }

  function sumPrecip(arr) {
    let s = 0;
    for (const v of arr) { if (v != null) s += v; }
    return Math.round(s * 100) / 100;
  }

  // ----------------------------------------------------------
  // FETCH HELPERS
  // ----------------------------------------------------------
  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) {
      let reason = res.statusText;
      try { const j = await res.json(); if (j.reason) reason = j.reason; } catch (e) {}
      throw new Error(`Open-Meteo ${res.status}: ${reason}`);
    }
    return res.json();
  }

  // Filter a daily timeseries to a season window (by month-of-year),
  // grouped by season-year, returning accumulated GDD & precip per year.
  function accumulateBySeasonYear(times, tmax, tmin, precip, lat, uptoToday) {
    const southern = isSouthern(lat);
    const today = new Date();
    const byYear = {}; // seasonYearKey -> {gdd, precip, days}

    for (let i = 0; i < times.length; i++) {
      const dt = new Date(times[i] + "T00:00");
      const m = dt.getMonth();   // 0-based
      const y = dt.getFullYear();

      // Is this date within a growing season, and which season-year does it belong to?
      let inSeason, seasonKey;
      if (southern) {
        // Season = Oct(y) .. Apr(y+1). Months 9,10,11 -> seasonKey y ; months 0,1,2,3 -> seasonKey y-1
        if (m >= 9) { inSeason = true; seasonKey = y; }
        else if (m <= 3) { inSeason = true; seasonKey = y - 1; }
        else inSeason = false;
      } else {
        // Season = Apr..Oct of same year. Months 3..9 (Apr..Oct=3..9? Oct=9). Include up to Oct 31 => month 9.
        if (m >= 3 && m <= 9) { inSeason = true; seasonKey = y; }
        else inSeason = false;
      }
      if (!inSeason) continue;

      // For the CURRENT season we only accumulate up to "today" (to-date comparison).
      if (uptoToday && dt > today) continue;

      if (!byYear[seasonKey]) byYear[seasonKey] = { gdd: 0, precip: 0, days: 0 };
      const tx = tmax[i], tn = tmin[i], pr = precip[i];
      if (tx != null && tn != null) {
        byYear[seasonKey].gdd += Math.max(0, (tx + tn) / 2 - BASE_TEMP_F);
      }
      if (pr != null) byYear[seasonKey].precip += pr;
      byYear[seasonKey].days += 1;
    }
    return byYear;
  }

  // ----------------------------------------------------------
  // MAIN: fetch + compute climate for one region
  // ----------------------------------------------------------
  async function fetchRegionClimate(region, opts) {
    opts = opts || {};
    // cache
    const cached = CACHE[region.id];
    if (cached && (Date.now() - cached.ts) < CACHE_TTL && !opts.force) {
      return cached.data;
    }

    const win = seasonWindow(region.lat);
    const today = new Date();
    const histStart = new Date(win.start);
    histStart.setFullYear(histStart.getFullYear() - HISTORY_YEARS);

    // --- Archive call: historical + current season to-date ---
    const archiveUrl = `${ARCHIVE_HOST}?latitude=${region.lat}&longitude=${region.lng}` +
      `&start_date=${fmtDate(histStart)}&end_date=${fmtDate(today)}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum` +
      `&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto`;

    // --- Forecast call: recent actuals + 16-day forecast (harvest rain risk) ---
    const forecastUrl = `${FORECAST_HOST}?latitude=${region.lat}&longitude=${region.lng}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum` +
      `&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto` +
      `&past_days=14&forecast_days=16`;

    const [archive, forecast] = await Promise.all([
      fetchJSON(archiveUrl),
      fetchJSON(forecastUrl)
    ]);

    // Accumulate per season-year from archive
    const ad = archive.daily;
    const byYear = accumulateBySeasonYear(
      ad.time, ad.temperature_2m_max, ad.temperature_2m_min, ad.precipitation_sum,
      region.lat, false
    );

    // Current season key
    const currentSeasonKey = (function () {
      const m = today.getMonth();
      const y = today.getFullYear();
      if (isSouthern(region.lat)) return (m <= 3) ? y - 1 : y;
      return y;
    })();

    // Current season-to-date (only up to today)
    const currentByYear = accumulateBySeasonYear(
      ad.time, ad.temperature_2m_max, ad.temperature_2m_min, ad.precipitation_sum,
      region.lat, true
    );
    const current = currentByYear[currentSeasonKey] || { gdd: 0, precip: 0, days: 0 };

    // Historical average to the SAME day-of-season:
    // Approximate by averaging completed past seasons' accumulation truncated
    // to the same number of days. Simpler robust approach: average past years'
    // accumulation over the same elapsed day count.
    const elapsedDays = current.days || 1;
    const pastKeys = Object.keys(byYear)
      .map(Number)
      .filter(k => k !== currentSeasonKey)
      .sort();

    // Recompute past-year accumulation truncated to elapsedDays for fair comparison
    const histTrunc = pastYearsTruncated(ad, region.lat, currentSeasonKey, elapsedDays);
    const gddAvg = avg(histTrunc.map(h => h.gdd));
    const precipAvg = avg(histTrunc.map(h => h.precip));

    // Harvest rain risk from forecast (is harvest near? how much rain forecast?)
    const harvest = assessHarvestRain(forecast.daily, region.lat, win);

    // Phenological stage metrics — GDD-based (self-adjusts to warmth & variety)
    const stages = computeStagesGDD(currentSeasonDaily(ad, region.lat), region);

    // Wildfire smoke exposure (US/wildfire-prone regions; air-quality archive ~2022+)
    const smoke = await fetchSmokeExposure(region);

    const data = {
      gddCurrent: Math.round(current.gdd),
      gddAvg: Math.round(gddAvg) || 1,
      precipCurrent: round2(current.precip),
      precipAvg: round2(precipAvg) || 0.01,
      elapsedDays,
      hemisphere: win.hemisphere,
      harvestRainRisk: harvest.risk,
      harvestRainForecast: harvest.totalInches,
      harvestNear: harvest.near,
      stages: stages,
      smoke: smoke,
      yearsOfHistory: histTrunc.length,
      fetchedAt: new Date().toISOString(),
      attribution: "Weather data by Open-Meteo.com"
    };

    CACHE[region.id] = { data, ts: Date.now() };
    return data;
  }

  // Recompute each past season's accumulation truncated to N elapsed days
  function pastYearsTruncated(ad, lat, currentSeasonKey, elapsedDays) {
    const southern = isSouthern(lat);
    // Group day indices by season-year in chronological order
    const groups = {};
    for (let i = 0; i < ad.time.length; i++) {
      const dt = new Date(ad.time[i] + "T00:00");
      const m = dt.getMonth(), y = dt.getFullYear();
      let inSeason, key;
      if (southern) {
        if (m >= 9) { inSeason = true; key = y; }
        else if (m <= 3) { inSeason = true; key = y - 1; }
        else inSeason = false;
      } else {
        if (m >= 3 && m <= 9) { inSeason = true; key = y; }
        else inSeason = false;
      }
      if (!inSeason || key === currentSeasonKey) continue;
      (groups[key] = groups[key] || []).push(i);
    }
    const out = [];
    Object.keys(groups).forEach(key => {
      const idxs = groups[key].slice(0, elapsedDays); // truncate to same elapsed length
      let gdd = 0, precip = 0;
      idxs.forEach(i => {
        const tx = ad.temperature_2m_max[i], tn = ad.temperature_2m_min[i], pr = ad.precipitation_sum[i];
        if (tx != null && tn != null) gdd += Math.max(0, (tx + tn) / 2 - BASE_TEMP_F);
        if (pr != null) precip += pr;
      });
      // Only include reasonably complete past seasons
      if (idxs.length >= Math.min(elapsedDays, 20)) out.push({ gdd, precip, days: idxs.length });
    });
    return out;
  }

  function assessHarvestRain(daily, lat, win) {
    // Look at the 16-day forecast window; sum precipitation.
    const total = sumPrecip(daily.precipitation_sum || []);
    // Are we within ~6 weeks of harvest?
    const today = new Date();
    const m = today.getMonth();
    const near = win.harvestMonths.includes(m) ||
                 win.harvestMonths.includes((m + 1) % 12);
    let risk;
    if (!near) {
      risk = total > 2.0 ? "Medium (not harvest)" : "Low (not harvest)";
    } else {
      if (total > 2.5) risk = "High";
      else if (total > 1.0) risk = "Medium";
      else risk = "Low";
    }
    return { risk, totalInches: total, near };
  }

  // ==========================================================
  // WILDFIRE SMOKE EXPOSURE (US / wildfire-prone regions)
  // PM2.5 during the ripening→harvest window is a smoke-taint proxy.
  // Note: Open-Meteo's air-quality archive only reaches ~2022, so this
  // is a live/recent-season factor. Historical smoke vintages are handled
  // via manual flags in the back-tester.
  // ==========================================================
  const AQ_HOST = "https://air-quality-api.open-meteo.com/v1/air-quality";

  // Red grapes suffer smoke taint more than whites (skin maceration extracts
  // smoke-derived volatile phenols; whites are pressed off skins quickly).
  const RED_GRAPES = new Set([
    "Cabernet Sauvignon","Merlot","Cabernet Franc","Pinot Noir","Syrah/Shiraz",
    "Nebbiolo","Tempranillo","Grenache","Malbec","Sangiovese","Mourvèdre",
    "Zinfandel","Touriga Nacional","Touriga Franca","Tinta Roriz","Tinta Barroca","Graciano","Garnacha"
  ]);
  function regionIsRed(region) {
    let red = 0, white = 0;
    region.varieties.forEach(v => { if (RED_GRAPES.has(v)) red++; else white++; });
    return red >= white;
  }

  function wildfireProne(region) {
    return region.country === "USA" || region.wildfireProne === true;
  }

  // Fetch daily-max PM2.5 across the ripening→harvest window and count smoky days.
  async function fetchSmokeExposure(region) {
    if (!wildfireProne(region)) return { available: false, applicable: false, smokyDays: 0, peakPM: 0 };
    const today = new Date();
    const south = region.lat < 0;
    const year = today.getFullYear();
    const start = south ? new Date(year, 1, 1) : new Date(year, 7, 1);    // Feb 1 / Aug 1
    const endCal = south ? new Date(year, 3, 30) : new Date(year, 9, 31); // Apr 30 / Oct 31
    const end = today < endCal ? today : endCal;
    if (end < start) return { available: true, applicable: true, smokyDays: 0, peakPM: 0, note: "ripening window not yet reached" };

    const url = `${AQ_HOST}?latitude=${region.lat}&longitude=${region.lng}` +
      `&hourly=pm2_5&start_date=${fmtDate(start)}&end_date=${fmtDate(end)}&timezone=auto`;
    try {
      const aq = await fetchJSON(url);
      const times = aq.hourly && aq.hourly.time, pm = aq.hourly && aq.hourly.pm2_5;
      if (!times || !pm) return { available: false, applicable: true, smokyDays: 0, peakPM: 0 };
      const dayMax = {};
      for (let i = 0; i < times.length; i++) {
        const d = times[i].slice(0, 10), v = pm[i];
        if (v == null) continue;
        if (dayMax[d] == null || v > dayMax[d]) dayMax[d] = v;
      }
      let smokyDays = 0, peak = 0;
      Object.values(dayMax).forEach(v => { if (v > 35) smokyDays++; if (v > peak) peak = v; });
      return { available: true, applicable: true, smokyDays, peakPM: Math.round(peak) };
    } catch (e) {
      return { available: false, applicable: true, smokyDays: 0, peakPM: 0, error: e.message };
    }
  }

  // Score a smoke-exposure object into points + a factor (red penalised more).
  function smokeFactor(smoke, region) {
    if (!smoke || !smoke.applicable || !smoke.available || smoke.smokyDays <= 0) return { pts: 0, factor: null };
    const red = regionIsRed(region);
    const d = smoke.smokyDays, pk = smoke.peakPM;
    let p;
    if (d > 10 || pk > 250) p = red ? -18 : -9;       // severe (2020-like): reds often declassified
    else if (d >= 4)        p = red ? -8  : -4;        // moderate
    else                    p = red ? -3  : -1;        // light
    return { pts: p, factor: { label: `[Ripening] Wildfire smoke (${d} smoky days, peak ${pk} µg/m³ PM2.5) — taint risk${red ? " (reds hit harder)" : ""}`, type: "neg" } };
  }

  // ==========================================================
  // PHENOLOGY / TIMING ENGINE
  // Buckets each day of the season into its growth stage and
  // judges stage-specific weather. Detectable thresholds:
  //   frost (Tmin <= 30F) at bud break
  //   wet/cold flowering -> poor fruit set (coulure)
  //   heat spikes (Tmax > 95F) at veraison
  //   rain during ripening -> dilution / rot ("watery, not sweet")
  // Stage windows are CALENDAR-based (approximate). The rigorous
  // upgrade is GDD-threshold staging — see notes in README.
  // ==========================================================
  const FROST_F       = 30;  // tender-shoot frost threshold
  const COLD_FLOWER_F = 60;  // cool day that disrupts flowering
  const HEAT_SPIKE_F  = 95;  // vine shutdown / sunburn risk

  // Map a date to a growth stage. Southern hemisphere shifted +6 months.
  function stageForDate(date, lat) {
    const south = lat < 0;
    const sm = south ? (date.getMonth() + 6) % 12 : date.getMonth();
    if (sm === 2 || sm === 3) return "budbreak";   // Mar–Apr (N)
    if (sm === 4 || sm === 5) return "flowering";  // May–Jun
    if (sm === 6 || sm === 7) return "veraison";   // Jul–Aug
    if (sm === 8 || sm === 9) return "harvest";    // Sep–Oct
    return null;                                    // dormant / off-season
  }

  // Which season-year does a date belong to (extended to include Mar/Sep)?
  function seasonKeyForDate(date, lat) {
    const m = date.getMonth(), y = date.getFullYear();
    if (lat < 0) { if (m >= 8) return y; if (m <= 3) return y - 1; return null; }
    return (m >= 2 && m <= 9) ? y : null;
  }

  // Extract current-season daily records (up to today) from archive series.
  function currentSeasonDaily(ad, lat) {
    const today = new Date();
    const key = seasonKeyForDate(today, lat);
    const out = { time: [], tmax: [], tmin: [], precip: [] };
    if (key == null) return out; // off-season (winter) — no staged data yet
    for (let i = 0; i < ad.time.length; i++) {
      const d = new Date(ad.time[i] + "T00:00");
      if (d > today) continue;
      if (seasonKeyForDate(d, lat) === key && stageForDate(d, lat)) {
        out.time.push(ad.time[i]);
        out.tmax.push(ad.temperature_2m_max[i]);
        out.tmin.push(ad.temperature_2m_min[i]);
        out.precip.push(ad.precipitation_sum[i]);
      }
    }
    return out;
  }

  // Compute per-stage metrics from a current-season daily slice.
  function computeStages(slice, lat) {
    const stages = {
      budbreak:  { frostDays: 0, minTmin: 999, days: 0 },
      flowering: { rain: 0, coldDays: 0, days: 0 },
      veraison:  { heatSpikeDays: 0, days: 0 },
      harvest:   { rain: 0, days: 0 }
    };
    for (let i = 0; i < slice.time.length; i++) {
      const d = new Date(slice.time[i] + "T00:00");
      const st = stageForDate(d, lat);
      if (!st) continue;
      const tx = slice.tmax[i], tn = slice.tmin[i], pr = slice.precip[i] || 0;
      const S = stages[st]; S.days++;
      if (st === "budbreak") {
        if (tn != null) { if (tn <= FROST_F) S.frostDays++; if (tn < S.minTmin) S.minTmin = tn; }
      } else if (st === "flowering") {
        S.rain += pr; if (tx != null && tx < COLD_FLOWER_F) S.coldDays++;
      } else if (st === "veraison") {
        if (tx != null && tx > HEAT_SPIKE_F) S.heatSpikeDays++;
      } else if (st === "harvest") {
        S.rain += pr;
      }
    }
    return stages;
  }

  // ----------------------------------------------------------
  // GDD-BASED STAGE BOUNDARIES (the rigorous upgrade)
  // Stages are defined by ACCUMULATED heat, not the calendar, so
  // a warm year reaches flowering/veraison earlier — like real vines.
  // Harvest anchor is variety-specific (uses the grape's ideal GDD).
  // Thresholds are in cumulative °F GDD (base 50). Approximate &
  // tunable — calibrate against observed phenology dates per region.
  // ----------------------------------------------------------
  const GDD_BUDBREAK_MAX = 350;     // frost-vulnerable early shoot growth
  const GDD_FLOWER       = [350, 750];
  const GDD_VERAISON     = [1250, 1750];
  const GDD_HARVEST_FLOOR = 1750;   // never start "harvest" before this

  // Average ideal-ripeness GDD across a region's varieties (for harvest anchor).
  function varietyTargetGDD(region) {
    const V = window.VARIETIES || {};
    const mins = [];
    region.varieties.forEach(v => {
      const d = V[v];
      if (d && d.idealGDD && typeof d.idealGDD.min === "number") mins.push(d.idealGDD.min);
    });
    return mins.length ? avg(mins) : 2200;
  }

  // Which stage does a given cumulative GDD fall into?
  function stageForGDD(cumGDD, harvestStart) {
    if (cumGDD <= GDD_BUDBREAK_MAX) return "budbreak";
    if (cumGDD >= GDD_FLOWER[0] && cumGDD <= GDD_FLOWER[1]) return "flowering";
    if (cumGDD >= GDD_VERAISON[0] && cumGDD <= GDD_VERAISON[1]) return "veraison";
    if (cumGDD >= harvestStart) return "harvest";
    return null; // transition periods we don't score
  }

  // GDD-based stage metrics. Walks days in order, accumulating heat,
  // and buckets each day by the GDD reached.
  function computeStagesGDD(slice, region) {
    const target = varietyTargetGDD(region);
    const harvestStart = Math.max(GDD_HARVEST_FLOOR, target - 150);
    const stages = {
      budbreak:  { frostDays: 0, minTmin: 999, days: 0 },
      flowering: { rain: 0, coldDays: 0, days: 0 },
      veraison:  { heatSpikeDays: 0, days: 0 },
      harvest:   { rain: 0, days: 0 },
      meta: { harvestStart: Math.round(harvestStart), targetGDD: Math.round(target) }
    };
    let cum = 0;
    for (let i = 0; i < slice.time.length; i++) {
      const tx = slice.tmax[i], tn = slice.tmin[i], pr = slice.precip[i] || 0;
      const gddDay = (tx != null && tn != null) ? Math.max(0, (tx + tn) / 2 - BASE_TEMP_F) : 0;
      cum += gddDay;
      const st = stageForGDD(cum, harvestStart);
      if (!st) continue;
      const S = stages[st]; S.days++;
      if (st === "budbreak") {
        if (tn != null) { if (tn <= FROST_F) S.frostDays++; if (tn < S.minTmin) S.minTmin = tn; }
      } else if (st === "flowering") {
        S.rain += pr; if (tx != null && tx < COLD_FLOWER_F) S.coldDays++;
      } else if (st === "veraison") {
        if (tx != null && tx > HEAT_SPIKE_F) S.heatSpikeDays++;
      } else if (st === "harvest") {
        S.rain += pr;
      }
    }
    stages.meta.currentCumGDD = Math.round(cum);
    stages.meta.currentStage = stageForGDD(cum, harvestStart) || "transition";
    return stages;
  }

  // Convert stage metrics into scored timing factors (variety-aware).
  function timingFactors(stages, region) {
    const factors = [];
    let pts = 0;
    const heatTol = varietyHeatProfile(region) === "tolerant";

    // --- Bud break: frost ---
    const fb = stages.budbreak;
    if (fb.days > 0 && fb.frostDays > 0) {
      const p = Math.max(-22, -8 * fb.frostDays); // severe; capped
      pts += p;
      factors.push({ label: `${fb.frostDays} frost day${fb.frostDays > 1 ? "s" : ""} at bud break (low ${Math.round(fb.minTmin)}°F)`, type: "neg", stage: "Bud break", pts: p });
    }

    // --- Flowering: wet or cold disrupts fruit set ---
    const fl = stages.flowering;
    if (fl.days > 0) {
      if (fl.rain > 2.0) { pts -= 8; factors.push({ label: `Wet flowering (${round2(fl.rain)}") — poor fruit-set / coulure risk`, type: "neg", stage: "Flowering", pts: -8 }); }
      else if (fl.coldDays >= 5) { pts -= 5; factors.push({ label: `Cold flowering (${fl.coldDays} cool days) — coulure risk`, type: "neg", stage: "Flowering", pts: -5 }); }
      else { pts += 3; factors.push({ label: `Clean flowering window`, type: "pos", stage: "Flowering", pts: 3 }); }
    }

    // --- Veraison: heat spikes ---
    const vr = stages.veraison;
    if (vr.days > 0 && vr.heatSpikeDays >= 5) {
      const p = heatTol ? -3 : -8;
      pts += p;
      factors.push({ label: `${vr.heatSpikeDays} heat-spike days (>95°F) in ripening`, type: "neg", stage: "Veraison", pts: p });
    }

    // --- Harvest approach: ripening-window rain (dilution / rot) ---
    const hv = stages.harvest;
    if (hv.days > 0) {
      if (hv.rain > 4.0) { pts -= 10; factors.push({ label: `Heavy ripening rain (${round2(hv.rain)}") — dilution & rot risk`, type: "neg", stage: "Harvest", pts: -10 }); }
      else if (hv.rain > 0 && hv.rain < 1.5) { pts += 5; factors.push({ label: `Dry ripening window (${round2(hv.rain)}") — concentration`, type: "pos", stage: "Harvest", pts: 5 }); }
    }

    return { pts, factors };
  }

  // ----------------------------------------------------------
  // SCORING — convert climate into score + tier + factors
  // Variety-aware via VARIETIES table.
  // ----------------------------------------------------------
  function scoreRegion(climate, region) {
    const gddRatio = climate.gddCurrent / climate.gddAvg;
    const rainRatio = climate.precipCurrent / climate.precipAvg;

    // Baseline 50 = a perfectly NORMAL year for this region.
    // This is a RELATIVE vintage index (deviation from normal),
    // NOT a prediction of the wine's critic score. Positive factors
    // mean "better than a typical year here"; negative, worse.
    let score = 50;
    const factors = [];

    // --- Heat / GDD (deviation from THIS region's 10-yr norm) ---
    // Normal heat for the region nets ~0; only genuine deviation moves the score.
    const heatProfile = varietyHeatProfile(region);
    if (gddRatio >= 0.92 && gddRatio <= 1.12) {
      if (gddRatio >= 1.00) { score += 2; factors.push({ label: `Reliably warm — ideal ripening (${pct(gddRatio)})`, type: "pos" }); }
      else { factors.push({ label: `Normal heat for the region (${pct(gddRatio)})`, type: "neu" }); }
    } else if (gddRatio > 1.12 && gddRatio <= 1.28) {
      if (heatProfile === "tolerant") { score += 3; factors.push({ label: `Warm — suits heat-tolerant varieties (${pct(gddRatio)})`, type: "pos" }); }
      else { score -= 4; factors.push({ label: `Warmer than normal (${pct(gddRatio)})`, type: "neg" }); }
    } else if (gddRatio > 1.28) {
      if (heatProfile === "tolerant") { score -= 6; factors.push({ label: `Very warm — manageable here (${pct(gddRatio)})`, type: "neg" }); }
      else { score -= 15; factors.push({ label: `Excessive heat — stress risk (${pct(gddRatio)})`, type: "neg" }); }
    } else if (gddRatio >= 0.80 && gddRatio < 0.92) {
      score -= 2; factors.push({ label: `Cooler than normal (${pct(gddRatio)})`, type: "neu" });
    } else { // < 0.80
      if (heatProfile === "sensitive") { score -= 6; factors.push({ label: `Cool — tolerable for cool-climate varieties (${pct(gddRatio)})`, type: "neg" }); }
      else { score -= 13; factors.push({ label: `Insufficient heat — underripe risk (${pct(gddRatio)})`, type: "neg" }); }
    }

    // --- Rainfall (deviation from norm) ---
    const droughtProfile = varietyDroughtProfile(region);
    if (rainRatio >= 0.70 && rainRatio <= 1.20) {
      factors.push({ label: `Normal rainfall (${pct(rainRatio)} of avg)`, type: "neu" }); // ~0
    } else if (rainRatio > 1.20 && rainRatio <= 1.50) {
      score -= 5;
      factors.push({ label: `Wetter than normal — disease pressure (${pct(rainRatio)})`, type: "neg" });
    } else if (rainRatio > 1.50) {
      score -= 13;
      factors.push({ label: `Excess rainfall — disease risk (${pct(rainRatio)})`, type: "neg" });
    } else if (rainRatio >= 0.45 && rainRatio < 0.70) {
      if (droughtProfile === "tolerant") { score += 2; factors.push({ label: `Dry — favorable for these varieties (${pct(rainRatio)})`, type: "pos" }); }
      else { score -= 2; factors.push({ label: `Drier than normal (${pct(rainRatio)})`, type: "neu" }); }
    } else { // < 0.45
      if (droughtProfile === "tolerant") { score -= 3; factors.push({ label: `Very dry — drought-adapted, coping (${pct(rainRatio)})`, type: "neu" }); }
      else { score -= 9; factors.push({ label: `Drought stress risk (${pct(rainRatio)})`, type: "neg" }); }
    }

    // --- Harvest rain risk (near-term forecast) ---
    if (climate.harvestNear) {
      if (climate.harvestRainRisk === "High") { score -= 11; factors.push({ label: `High harvest-rain risk (${climate.harvestRainForecast}" forecast)`, type: "neg" }); }
      else if (climate.harvestRainRisk === "Medium") { score -= 4; factors.push({ label: `Some harvest-rain risk`, type: "neu" }); }
      else { score += 4; factors.push({ label: `Dry harvest window forecast`, type: "pos" }); }
    }

    // --- Timing / phenology factors (frost, flowering, veraison, ripening rain) ---
    let timing = { pts: 0, factors: [] };
    if (climate.stages) {
      timing = timingFactors(climate.stages, region);
      score += timing.pts;
      timing.factors.forEach(f => factors.push({ label: `[${f.stage}] ${f.label}`, type: f.type }));
    }

    // --- Wildfire smoke (US/wildfire-prone; live/recent seasons) ---
    if (climate.smoke) {
      const sf = smokeFactor(climate.smoke, region);
      if (sf.factor) { score += sf.pts; factors.push(sf.factor); }
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    // Tiers, shifted -25 from the old 90/65 cutoffs to match the
    // recentred baseline — so classifications are unchanged, only
    // the number is now honest (50 = normal).
    let tier;
    if (score >= 65) tier = "watch";
    else if (score >= 40) tier = "normal";
    else tier = "concern";

    return { score, tier, factors, gddRatio, rainRatio, timing };
  }

  // Determine if a region's varieties are mostly heat-tolerant or heat-sensitive
  function varietyHeatProfile(region) {
    const V = window.VARIETIES || {};
    let tol = 0, sens = 0;
    region.varieties.forEach(v => {
      const d = V[v];
      if (!d) return;
      if (d.heatTolerance === "High" || d.heatTolerance === "Very High") tol++;
      if (d.heatTolerance === "Low") sens++;
    });
    if (tol > sens) return "tolerant";
    if (sens > tol) return "sensitive";
    return "neutral";
  }

  function varietyDroughtProfile(region) {
    const V = window.VARIETIES || {};
    let tol = 0, sens = 0;
    region.varieties.forEach(v => {
      const d = V[v];
      if (!d) return;
      if (d.droughtTolerance === "High" || d.droughtTolerance === "Very High") tol++;
      if (d.droughtTolerance === "Low") sens++;
    });
    if (tol > sens) return "tolerant";
    if (sens > tol) return "sensitive";
    return "neutral";
  }

  // ----------------------------------------------------------
  // Generate an auto-written outlook sentence
  // ----------------------------------------------------------
  function autoOutlook(climate, scored, region) {
    const heat = scored.gddRatio >= 1.12 ? "running warmer than its 10-year norm"
              : scored.gddRatio <= 0.88 ? "cooler than its 10-year norm"
              : "tracking close to its 10-year norm for heat accumulation";
    const rain = scored.rainRatio >= 1.5 ? "with notably wet conditions raising disease pressure"
              : scored.rainRatio >= 1.15 ? "with above-average rainfall"
              : scored.rainRatio <= 0.5 ? "under markedly dry conditions"
              : "with broadly balanced rainfall";
    const harvest = climate.harvestNear
      ? (climate.harvestRainRisk === "High" ? " The near-term forecast shows meaningful rain entering the harvest window — a risk to watch."
        : climate.harvestRainRisk === "Low" ? " The harvest window looks dry in the latest forecast, which is favorable."
        : " Harvest-window weather is mixed in the current forecast.")
      : "";
    const tierPhrase = scored.tier === "watch" ? "Conditions point to a potentially excellent vintage."
      : scored.tier === "concern" ? "Conditions are challenging this season; favor top producers and well-drained sites."
      : "The season is tracking near its historical norm.";
    return `Auto-assessed from live climate data: the ${region.name} growing season is ${heat}, ${rain}.${harvest} ${tierPhrase} (Based on ${climate.elapsedDays} days of season data vs a ${climate.yearsOfHistory}-year baseline.)`;
  }

  // ----------------------------------------------------------
  // PUBLIC: auto-populate a single region object in place
  // ----------------------------------------------------------
  async function populateRegion(region, opts) {
    const climate = await fetchRegionClimate(region, opts);
    const scored = scoreRegion(climate, region);

    // Preserve manual data first time
    if (region.dataMode !== "live") {
      region.manualOutlook = region.outlook;
      region.manualScore = region.score;
      region.manualTier = region.tier;
      region.manualFactors = region.climateFactors;
    }

    region.score = scored.score;
    region.tier = scored.tier;
    region.climateFactors = scored.factors;
    region.outlook = autoOutlook(climate, scored, region);
    region.gdd = {
      current: climate.gddCurrent,
      average: climate.gddAvg,
      unit: "°F GDD"
    };
    region.rainfall = {
      ytd: pct(climate.precipCurrent / climate.precipAvg),
      harvest_risk: climate.harvestRainRisk
    };
    region.dataSource = `Open-Meteo live data (${climate.hemisphere} Hem.) · fetched ${new Date(climate.fetchedAt).toLocaleString()} · ${climate.attribution}`;
    region.dataMode = "live";
    region._climate = climate;
    return region;
  }

  // ----------------------------------------------------------
  // PUBLIC: auto-populate ALL regions with progress callback
  // ----------------------------------------------------------
  async function populateAll(regions, onProgress, opts) {
    let done = 0;
    const total = regions.length;
    const errors = [];
    // Sequential to be gentle on the free API & give smooth progress
    for (const r of regions) {
      try {
        await populateRegion(r, opts);
      } catch (e) {
        errors.push({ region: r.name, error: e.message });
      }
      done++;
      if (onProgress) onProgress(done, total, r.name, errors.length);
    }
    return { done, total, errors };
  }

  // ---- utils ----
  function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function pct(ratio) { return Math.round(ratio * 100) + "%"; }

  return {
    fetchRegionClimate,
    scoreRegion,
    populateRegion,
    populateAll,
    computeGDD,
    seasonWindow,
    _internal: { accumulateBySeasonYear, pastYearsTruncated, assessHarvestRain,
                 stageForDate, currentSeasonDaily, computeStages, timingFactors,
                 varietyHeatProfile, varietyDroughtProfile,
                 computeStagesGDD, stageForGDD, varietyTargetGDD,
                 fetchSmokeExposure, smokeFactor, regionIsRed, wildfireProne }
  };
})();

window.WEATHER = WEATHER;
