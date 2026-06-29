# Terroir Intelligence — Vintage Climate Outlook

A durable, self-contained HTML/JS tool for producing quarterly or yearly wine vintage outlook reports by cross-referencing climate data against varietal growing thresholds.

## What it does

For each wine region, it combines:
- **Climate data** (Growing Degree Days, rainfall, harvest-rain risk, ENSO influence)
- **Varietal thresholds** (what each grape needs to thrive)

...into a 0–100 vintage outlook score, sorted into three tiers:
- ★ **Watch List** — exceptional conditions, wines to seek out
- ○ **Normal** — tracking close to historical norms
- ⚠ **Concern** — difficult conditions, favor top producers

## Running it

For the map tiles and fonts to load, you need an internet connection (they're loaded from CDNs).

## Auto-populating weather (no manual data entry)

Click **⚡ Auto-Populate from Live Climate Data** on the dashboard. The tool pulls live data directly from [Open-Meteo](https://open-meteo.com) — no API key, no backend, runs entirely in your browser. For each region it:

1. Fetches ~10 years of daily temperature + rainfall (ERA5 archive) for the historical baseline
2. Fetches the current season-to-date and computes **Growing Degree Days** in the browser (base 50°F)
3. Fetches the 16-day forecast to assess **harvest-rain risk**
4. Scores each region 0–100 **variety-aware** — a hot, dry year boosts heat-tolerant Grenache/Syrah but penalizes heat-sensitive Pinot/Riesling, using `data/varieties.js`
5. Auto-writes the outlook text, sets the tier, and updates every card, the map, and the report

Open-Meteo aggregates NOAA, ECMWF, Météo-France, DWD, BOM, JMA and other national weather services, so you're getting verified national-agency model data.

**Revert anytime:** the "Revert to manual data" button restores your hand-written assessments — the tool keeps both so you never lose your manual work.

### Tuning the scoring

The scoring thresholds live in `scoreRegion()` inside `data/weather.js` — clearly commented. Adjust the GDD/rainfall bands or the variety-awareness logic to match your own judgment as you validate predictions against real outcomes.

## The score is a relative index (50 = normal)

The vintage score is **not** a prediction of the wine's critic rating. It's a **relative index**: **50 = a perfectly normal year for that region**. Above 50 = better than typical; below = worse. Tiers: **≥65 Watch (exceptional), 40–64 Normal, <40 Concern.**

Every factor is a *deviation from the region's own 10-year norm*, so "normal conditions" contribute ~0 and only genuine departures move the score. This is why a dead-average season lands near 50 and why "Watch" is rare and earned — it takes several things going right at once.

> Note: the factor magnitudes (how many points each band is worth) are reasoned but **provisional** — calibrating them against published vintage/critic scores is exactly what the back-testing module is for.

## GDD-based phenological staging

Growth stages are now defined by **accumulated Growing Degree Days, not the calendar**, so a warm year reaches flowering and veraison earlier — like real vines do. The harvest/ripeness anchor is **variety-specific**: it uses each grape's ideal-GDD range, so Cabernet (needs ~2,350 GDD) enters its harvest window later than Pinot (~1,750). Calendar months still decide whether a day is in the growing season at all; GDD decides which *stage* within it.

Stage thresholds (cumulative °F GDD, tunable in `data/weather.js`): bud break ≤350 · flowering 350–750 · veraison 1,250–1,750 · harvest ≥ max(1,750, varietyTarget−150).

## Timing / phenology factors (stage-aware analysis)

Beyond season-long averages, the model now buckets each day into its **growth stage** and judges stage-specific weather. This captures the "same rain, opposite meaning depending on when" reality of viticulture.

| Stage | Window (N. hem.) | Detects | Penalty |
|---|---|---|---|
| Bud break | Mar–Apr | Frost nights (Tmin ≤ 30°F) | up to −22 (−8/day) |
| Flowering | May–Jun | Wet (>2") or cold flowering → poor fruit set | −8 / −5 |
| Veraison | Jul–Aug | Heat-spike days (Tmax > 95°F) | −8 (−3 if heat-tolerant) |
| Harvest approach | Sep–Oct | Ripening-window rain → dilution & rot | −10, or +5 if dry |

These come from the actual daily `temperature_2m_min`, `temperature_2m_max`, and `precipitation_sum` Open-Meteo already returns — no extra data needed. Factors appear on each card/report tagged by stage, e.g. `[Bud break] 1 frost day at bud break (low 28°F)`.

The model only scores stages that have **already happened** — it won't penalize ripening rain in June because ripening hasn't occurred yet. This makes the score sharpen as the season progresses.

**Tuning:** all thresholds and point values live in `timingFactors()` and the stage constants (`FROST_F`, `COLD_FLOWER_F`, `HEAT_SPIKE_F`) at the top of the phenology section in `data/weather.js`.

**Known limitation — calendar vs GDD staging:** stage windows are currently calendar-based (approximate). The rigorous upgrade is **GDD-threshold staging**, where flowering/veraison are defined by accumulated heat rather than dates — this self-adjusts to each region and to warm vs cool years (a hot year reaches flowering earlier). That's the next accuracy improvement.


## Back-testing & validation (backtesting.html)

`backtesting.html` is a standalone lab that validates the model against history. It:

1. Fetches full-season **archive** weather (Open-Meteo, back to 1940) for each region-year in your ground-truth set, plus the 10 years before it for the baseline
2. Scores each completed season with the model
3. Correlates predictions against known vintage quality using **rank correlation** (Spearman) — the right metric for a *relative* index, since it tests whether the model orders each region's good/bad years correctly, independent of scale
4. Shows: pooled correlation, per-region Spearman, a predicted-vs-actual scatter, and a "where the model misses" residual table
5. Lets you **tune the weights with sliders** and watch correlation update instantly (cached weather, no refetch), then **export** the tuned weights to paste into `weather.js`

**Ground-truth data:** the seed vintage scores in `VINTAGES` are rough consensus characterizations included so it runs out of the box — **replace them with figures from your authoritative source.** Because validation is rank-based, ordering matters more than exact numbers.

**Reading the result:** pooled r ≥0.6 = strong (the model reliably orders vintages), 0.35–0.6 = moderate, <0.35 = weak (tune weights or revisit thresholds). The residual table tells you *which* region-years the model gets most wrong — those are your clues for what factor is missing (often timing nuance the calendar/GDD windows don't yet capture).

**Workflow:** run → inspect correlation & residuals → tune sliders to improve fit → export weights → paste into `weather.js`. Re-run periodically as you add more ground-truth years.


## Wildfire smoke factor (US regions)

Smoke taint — volatile phenols from wildfire smoke absorbed through grape skins — can ruin a vintage (Napa/Sonoma 2020 saw widespread declassification). The model now accounts for it:

**Live / recent seasons (2022+):** for US (or any `wildfireProne`) region, it fetches **PM2.5** from Open-Meteo's Air Quality API (no key, CORS) across the ripening→harvest window and counts "smoky days" (daily-max PM2.5 > 35 µg/m³). Penalty scales with severity, and **reds are hit harder than whites** (skin maceration extracts the smoke compounds; whites are pressed off quickly): light −3/−1, moderate −8/−4, severe (2020-like) −18/−9. Only the post-veraison window counts, since that's when grapes absorb smoke.

**Historical back-testing (pre-2022):** the air-quality archive only reaches ~2022, so the famous smoke years can't be fetched client-side. Instead, `backtesting.html` has a manual `SMOKE_EVENTS` map (seeded with Napa 2017/2018/2020/2021) you edit by hand — the major smoke vintages are few and well-documented. Severity flags apply the same red/white penalty during validation.

To add a wildfire-prone region outside the US, set `wildfireProne: true` on it in `regions.js`.

## File structure

```
wine-vintage-intel/
├── terroir-intelligence.html          ← main page, structure
├── styles.css          ← all styling
├── app.js              ← UI logic (cards, map, modal, report, auto-populate)
└── data/
    ├── regions.js      ← region list + coordinates (edit to add regions)
    ├── varieties.js    ← grape variety climate thresholds
    └── weather.js      ← live data engine (Open-Meteo fetch + GDD + scoring)
```

Standalone tools (open directly):
- `terroir-intelligence.html` — the full app, single self-contained file
- `scoring-explainer.html` — interactive breakdown of how a score is built
- `backtesting.html` — validation & weight-tuning lab (with manual smoke-event flags)
- `vintage-entry.html` — helper for entering ground-truth vintage scores


## How to update it each quarter (your workflow)

1. **Gather forecast data** from the sources linked in the Settings tab:
   - NOAA Climate Prediction Center (3-month outlook)
   - Copernicus C3S seasonal forecasts (Europe)
   - NOAA / BOM ENSO advisories (El Niño / La Niña)
2. **Open `data/regions.js`** and update each region's:
   - `score` (0–100)
   - `tier` ("watch" / "normal" / "concern")
   - `outlook` (your written assessment)
   - `climateFactors` (the colored tags)
   - `gdd`, `rainfall` (the indicator numbers)
3. **Reload the page.** Cards, map, tiers, and report all update automatically.
4. Go to the **Report tab** → "Copy as Text" (for Substack/email) or "Print / Save PDF".

## Adding a new region

Copy any region object in `data/regions.js`, change the fields, and add it to the `REGIONS` array. The template and field explanations are at the top of that file. Everything else (cards, map markers, filters, report) picks it up automatically.

## Adding appellation boundary maps (GeoJSON)

The map shows point markers by default. To show actual appellation boundaries:
1. Get a GeoJSON file of wine regions. Free sources:
   - Natural Earth (admin boundaries)
   - OpenStreetMap / Overpass API (search for `wine region` relations)
   - Community wine-region GeoJSON repos on GitHub
2. Settings tab → "Load GeoJSON" → select your file
3. Switch to the Region Map tab to see boundaries overlaid

## Customizing branding

Settings tab → set your report title, author/newsletter name, and tagline.
Use "Export Config JSON" to save these settings to a file so they persist
(re-import with "Import Config" next session).

## Monetization paths

- **Substack newsletter** — free tier + paid ($8–15/mo) quarterly outlook. The "Copy as Text" button is built for this.
- **Affiliate links** — link "watch list" wines to Wine.com / Vivino affiliate programs (links in Settings)
- **B2B PDF reports** — sell to wine shops, sommeliers, restaurant buyers ($50–200/report)
- **White-label embed** — license the branded tool to a retailer ($100–300/mo)

## Important caveats (for credibility)

- The current region data is **illustrative sample data** for a 2025 outlook. Before publishing, replace it with current verified forecast data you've pulled yourself.
- This is a **probabilistic outlook, not a guarantee.** Harvest-time weather is the decisive variable and can't be fully forecast months out.
- Keep the methodology/sources note in the report — transparency is what makes this credible vs. guesswork.

## Extending further (future ideas)

- **Historical back-testing**: add a `data/vintages.js` with past critic scores (Wine Spectator, Jancis Robinson) and weather, to validate your scoring model against what actually happened.
- **Live API integration**: replace manual data entry by fetching NOAA/Copernicus APIs directly (requires a small backend or serverless function to avoid CORS).
- **Sub-region granularity**: split big regions into AVAs/crus for single-vineyard precision.
- **Auto-tier**: a function that sets `tier` from `score` automatically.
