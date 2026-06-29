// @ts-nocheck
/**
 * Dev-time generator for the bright-star backdrop + interstellar navigable
 * additions + constellation line figures. Run manually:
 *
 *     node scripts/genStars.mjs
 *
 * It fetches two openly-published datasets at generation time and emits committed
 * TypeScript modules (only the generated output is committed — the multi-MB source
 * tables are not). It is NOT wired into `npm run build`, which stays IO/network-free.
 *
 * Sources
 *   - Stars: HYG database v4.1 (astronexus). License CC BY-SA 4.0 (the DATA, not code).
 *            https://github.com/astronexus/HYG-Database
 *   - Constellation figures: d3-celestial `constellations.lines.json` (Olaf Frohn).
 *            License BSD-2-Clause. https://github.com/ofrohn/d3-celestial
 *
 * The two tiers it produces (a clean distance split, so no overlap with the 27
 * hand-curated systems in packages/engine/src/stars.ts, all of which are <= ~12 ly):
 *   - NAVIGABLE additions: notable stars in (CURATED_MAX, REACH_LY] ly — new
 *     interstellar travel destinations (Altair, Vega, Fomalhaut, 40 Eridani, …).
 *   - BACKDROP: bright stars beyond REACH_LY down to MAG_LIMIT — a fixed sky.
 *
 * Constellation lines are emitted as ecliptic-J2000 unit-direction polylines
 * (precomputed here with the SAME obliquity rotation as packages/engine/src/stars.ts), so the
 * renderer just draws them on the camera-anchored sky sphere — no coupling to which
 * stars are in the catalog.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../packages/engine/src");

const HYG_URL =
  "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv";
const LINES_URL =
  "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json";

// ── Tunables ────────────────────────────────────────────────────────────────
const PC_TO_LY = 3.2615637769;
const CURATED_MAX_LY = 12.0; // the hand-curated set is volume-complete to ~12 ly
const REACH_LY = 26.0; // interstellar reach — includes Vega/Fomalhaut (~25 ly)
const MAG_LIMIT = 4.0; // backdrop faint limit (constellation-filling)
const ADDITION_MAG = 4.5; // a 12–26 ly star this bright is a "notable" destination
const DEDUP_ARCMIN = 1.0; // collapse split double-star rows closer than this

// ── Frame conversion (must match packages/engine/src/stars.ts exactly) ─────────────────
const OBLIQUITY = (23.4392911 * Math.PI) / 180;
const CO = Math.cos(OBLIQUITY), SO = Math.sin(OBLIQUITY);
/** Equatorial-J2000 unit direction (ra, dec in rad) → ecliptic-J2000 unit vector. */
function radecToEclipticDir(ra, dec) {
  const xe = Math.cos(dec) * Math.cos(ra);
  const ye = Math.cos(dec) * Math.sin(ra);
  const ze = Math.sin(dec);
  return { x: xe, y: ye * CO + ze * SO, z: -ye * SO + ze * CO };
}

// ── CSV (quote-aware, line by line) ─────────────────────────────────────────
function parseCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// ── Spectral type / mass helpers (for additions, which need full StarDef) ───
/** Synthesize a spectral class string from B–V when HYG `spect` is blank. */
function bvToSpectral(bv) {
  if (bv === null || Number.isNaN(bv)) return "G5";
  // Coarse main-sequence B–V → class boundaries.
  const table = [
    [-0.33, "B0"], [-0.17, "B7"], [0.0, "A0"], [0.15, "A5"], [0.3, "F0"],
    [0.44, "F5"], [0.58, "G0"], [0.68, "G5"], [0.81, "K0"], [1.15, "K5"],
    [1.4, "M0"], [1.64, "M3"], [2.0, "M5"],
  ];
  for (const [lim, cls] of table) if (bv <= lim) return cls;
  return "M6";
}
/** Rough nominal mass (M_sun) from leading spectral class — never simulated, only
 *  satisfies the StarDef type and a test. */
function nominalMass(spect) {
  const c = (spect || "G").charAt(0).toUpperCase();
  return { O: 20, B: 6, A: 2, F: 1.4, G: 1.0, K: 0.7, M: 0.3, L: 0.08, T: 0.04, D: 0.6 }[c] ?? 1.0;
}

function slug(s) {
  return s.toLowerCase().replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// HYG `bayer` is a 3-letter Greek abbreviation (e.g. "Alp", "Bet", optionally with
// a component digit like "Alp1"). Format it as the Greek letter for nicer labels.
const GREEK = {
  alp: "α", bet: "β", gam: "γ", del: "δ", eps: "ε", zet: "ζ", eta: "η", the: "θ",
  iot: "ι", kap: "κ", lam: "λ", mu: "μ", nu: "ν", xi: "ξ", omi: "ο", pi: "π",
  rho: "ρ", sig: "σ", tau: "τ", ups: "υ", phi: "φ", chi: "χ", psi: "ψ", ome: "ω",
};
function formatName(proper, bayer, flam, con, hip, hd) {
  if (proper) return proper;
  if (bayer && con) {
    const m = bayer.toLowerCase().match(/^([a-z]+)(\d*)$/);
    const g = m && GREEK[m[1]];
    if (g) return `${g}${m[2] || ""} ${con}`;
    return `${bayer} ${con}`;
  }
  if (flam && con) return `${flam} ${con}`;
  if (hip) return `HIP ${hip}`;
  return hd ? `HD ${hd}` : "Unknown";
}
function idBase(proper, bayer, flam, con, hip) {
  if (proper) return slug(proper);
  if (bayer && con) return slug(`${bayer} ${con}`);
  if (flam && con) return slug(`${flam} ${con}`);
  return `hip-${hip || "x"}`;
}
function num(s) {
  if (s === undefined || s === "") return null;
  const v = Number(s);
  return Number.isNaN(v) ? null : v;
}
function r6(v) { return Math.round(v * 1e6) / 1e6; }
function r4(v) { return Math.round(v * 1e4) / 1e4; }

// ── Fetch ───────────────────────────────────────────────────────────────────
async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return r.text();
}

async function main() {
  console.log("Fetching HYG …");
  const csv = await fetchText(HYG_URL);
  console.log("Fetching constellation lines …");
  const linesJson = JSON.parse(await fetchText(LINES_URL));

  const rows = csv.split(/\r?\n/);
  const header = parseCsvLine(rows[0]);
  const col = (name) => header.indexOf(name);
  const I = {
    hip: col("hip"), hd: col("hd"), proper: col("proper"), dist: col("dist"), mag: col("mag"),
    absmag: col("absmag"), spect: col("spect"), ci: col("ci"), lum: col("lum"),
    rarad: col("rarad"), decrad: col("decrad"), pmra: col("pmra"), pmdec: col("pmdec"),
    rv: col("rv"), bayer: col("bayer"), flam: col("flam"), con: col("con"),
    comp: col("comp"), compPrimary: col("comp_primary"),
  };

  const additions = [];
  const backdrop = [];
  const usedIds = new Set();
  // Curated ids (all <= 12 ly) — additions/backdrop start above that, but guard slugs.
  for (const id of [
    "proxima", "alpha-cen-a", "alpha-cen-b", "barnard", "luhman16", "wolf359",
    "lalande21185", "sirius-a", "sirius-b", "luyten726-8a", "luyten726-8b",
    "ross154", "ross248", "epsilon-eridani", "lacaille9352", "ross128",
    "ez-aquarii", "procyon-a", "procyon-b", "61cyg-a", "61cyg-b", "struve2398a",
    "struve2398b", "groombridge34a", "groombridge34b", "epsilon-indi", "tau-ceti",
  ]) usedIds.add(id);

  const uniqueId = (base) => {
    let id = base || "star";
    if (!usedIds.has(id)) { usedIds.add(id); return id; }
    let n = 2;
    while (usedIds.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
    usedIds.add(id);
    return id;
  };

  // Position-keyed de-dup of split double-star rows: keep the brightest at a spot.
  const seen = new Map(); // key -> { magVal, bucket index pushed }
  const dedupKey = (ra, dec) => {
    const a = DEDUP_ARCMIN / 60 * Math.PI / 180;
    return `${Math.round(ra / a)},${Math.round(dec / a)}`;
  };

  for (let i = 1; i < rows.length; i++) {
    const line = rows[i];
    if (!line) continue;
    const f = parseCsvLine(line);
    const hip = f[I.hip];
    const distPc = num(f[I.dist]);
    if (distPc === null || distPc <= 0) continue; // no parallax → unplaceable
    const distLy = distPc * PC_TO_LY;
    if (distLy <= CURATED_MAX_LY) continue; // curated set owns <= 12 ly
    const mag = num(f[I.mag]);
    if (mag === null) continue;
    const ra = num(f[I.rarad]);
    const dec = num(f[I.decrad]);
    if (ra === null || dec === null) continue;
    const proper = (f[I.proper] || "").trim();
    const ci = num(f[I.ci]);
    let spect = (f[I.spect] || "").trim();
    if (!spect) spect = bvToSpectral(ci);
    const con = (f[I.con] || "").trim();
    const bayer = (f[I.bayer] || "").trim();
    const flam = (f[I.flam] || "").trim();
    const hd = (f[I.hd] || "").trim();

    // Additions are gated by VISIBILITY (the close members of the famous set), not
    // by having an astronomer's name — so dim nearby dwarfs stay out of the
    // travel-target list (the curated catalog already covers nearby dim systems).
    const isAddition = distLy <= REACH_LY && mag <= ADDITION_MAG;
    const isBackdrop = distLy > REACH_LY && mag <= MAG_LIMIT;
    if (!isAddition && !isBackdrop) continue;

    const key = dedupKey(ra, dec);
    const prev = seen.get(key);
    if (prev && prev.mag <= mag) continue; // a brighter row already holds this spot

    const name = formatName(proper, bayer, flam, con, hip, hd);

    let record;
    if (isAddition) {
      const lum = num(f[I.lum]) ?? (num(f[I.absmag]) !== null ? 10 ** (0.4 * (4.85 - num(f[I.absmag]))) : 1);
      record = {
        bucket: "add",
        id: uniqueId(idBase(proper, bayer, flam, con, hip)),
        name,
        ra: r6(ra), dec: r6(dec), distanceLy: r4(distLy),
        pmRA: r4(num(f[I.pmra]) ?? 0), pmDec: r4(num(f[I.pmdec]) ?? 0), rv: r4(num(f[I.rv]) ?? 0),
        spectralType: spect, luminosity: r4(lum), massSun: nominalMass(spect),
        appMag: mag, con: con || undefined, bayer: bayer || undefined,
        hip: hip ? Number(hip) : undefined,
      };
    } else {
      record = {
        bucket: "back",
        id: uniqueId(idBase(proper, bayer, flam, con, hip)),
        name,
        ra: r6(ra), dec: r6(dec), distanceLy: r4(distLy),
        spectralType: spect, appMag: mag,
        con: con || undefined, bayer: bayer || undefined,
      };
    }
    if (prev) {
      // Replace the dimmer occupant in place.
      const arr = prev.bucket === "add" ? additions : backdrop;
      const idx = arr.indexOf(prev.ref);
      if (idx >= 0) arr.splice(idx, 1);
      usedIds.delete(prev.ref.id);
    }
    (isAddition ? additions : backdrop).push(record);
    seen.set(key, { mag, bucket: record.bucket, ref: record });
  }

  additions.sort((a, b) => a.distanceLy - b.distanceLy);
  backdrop.sort((a, b) => a.appMag - b.appMag);

  // ── Constellation lines → ecliptic unit-direction polylines ───────────────
  const figures = [];
  let segCount = 0;
  for (const feat of linesJson.features) {
    const id = feat.id;
    const polylines = [];
    for (const poly of feat.geometry.coordinates) {
      const flat = [];
      for (const [raDeg, decDeg] of poly) {
        const d = radecToEclipticDir((raDeg * Math.PI) / 180, (decDeg * Math.PI) / 180);
        flat.push(r6(d.x), r6(d.y), r6(d.z));
      }
      if (flat.length >= 6) { polylines.push(flat); segCount += flat.length / 3 - 1; }
    }
    if (polylines.length) figures.push({ id, polylines });
  }
  figures.sort((a, b) => a.id.localeCompare(b.id));

  // ── Emit ──────────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString().slice(0, 10);
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const opt = (k, v) => (v === undefined ? "" : `, ${k}: ${typeof v === "string" ? `"${esc(v)}"` : v}`);

  const addLine = (s) =>
    `  { id: "${esc(s.id)}", name: "${esc(s.name)}", ra: ${s.ra}, dec: ${s.dec}, distanceLy: ${s.distanceLy},` +
    ` pmRA: ${s.pmRA}, pmDec: ${s.pmDec}, rv: ${s.rv}, spectralType: "${esc(s.spectralType)}",` +
    ` luminosity: ${s.luminosity}, massSun: ${s.massSun}, appMag: ${s.appMag}` +
    `${opt("con", s.con)}${opt("bayer", s.bayer)}${opt("hip", s.hip)} },`;

  const backLine = (s) =>
    `  { id: "${esc(s.id)}", name: "${esc(s.name)}", ra: ${s.ra}, dec: ${s.dec}, distanceLy: ${s.distanceLy},` +
    ` spectralType: "${esc(s.spectralType)}", appMag: ${s.appMag}${opt("con", s.con)}${opt("bayer", s.bayer)} },`;

  const starsTs =
`// AUTO-GENERATED by scripts/genStars.mjs on ${stamp} — DO NOT EDIT BY HAND.
// Star data: HYG database v4.1 (astronexus), licensed CC BY-SA 4.0.
// Source: https://github.com/astronexus/HYG-Database
//
// Two tiers split purely by distance so there is no overlap with the hand-curated
// nearby systems in stars.ts (all <= ${CURATED_MAX_LY} ly):
//   NAVIGABLE_ADDITION_SEEDS — notable stars in (${CURATED_MAX_LY}, ${REACH_LY}] ly, new travel targets.
//   BACKDROP_SEEDS           — bright stars beyond ${REACH_LY} ly down to mag ${MAG_LIMIT}, a fixed sky.
import type { StarSeed, BackdropSeed } from "./stars.ts";

/** ${additions.length} notable systems in (${CURATED_MAX_LY}, ${REACH_LY}] ly — real interstellar destinations. */
export const NAVIGABLE_ADDITION_SEEDS: StarSeed[] = [
${additions.map(addLine).join("\n")}
];

/** ${backdrop.length} bright stars beyond ${REACH_LY} ly (to mag ${MAG_LIMIT}) — the fixed celestial backdrop. */
export const BACKDROP_SEEDS: BackdropSeed[] = [
${backdrop.map(backLine).join("\n")}
];
`;

  const linesTs =
`// AUTO-GENERATED by scripts/genStars.mjs on ${stamp} — DO NOT EDIT BY HAND.
// Constellation figures: d3-celestial constellations.lines.json (Olaf Frohn),
// licensed BSD-2-Clause. Source: https://github.com/ofrohn/d3-celestial
//
// Each polyline is a flat list of ecliptic-J2000 UNIT direction triplets
// [x0,y0,z0, x1,y1,z1, …] (precomputed with the J2000 obliquity, matching
// radecToEcliptic in stars.ts), drawn as a connected line on the sky sphere.

/** A constellation stick-figure: one or more connected polylines of sky directions. */
export interface ConstellationFigure {
  /** IAU 3-letter abbreviation, e.g. "Ori". */
  id: string;
  /** Polylines; each is [x,y,z, x,y,z, …] unit directions connected in order. */
  polylines: number[][];
}

/** ${figures.length} constellation figures, ${segCount} line segments total. */
export const CONSTELLATION_LINES: ConstellationFigure[] = [
${figures.map((g) => `  { id: "${esc(g.id)}", polylines: [${g.polylines.map((p) => `[${p.join(",")}]`).join(", ")}] },`).join("\n")}
];
`;

  writeFileSync(resolve(OUT_DIR, "brightStars.generated.ts"), starsTs);
  writeFileSync(resolve(OUT_DIR, "constellationLines.generated.ts"), linesTs);

  console.log(`\nWrote brightStars.generated.ts: ${additions.length} additions, ${backdrop.length} backdrop`);
  console.log(`Wrote constellationLines.generated.ts: ${figures.length} figures, ${segCount} segments`);
  console.log(`\nNavigable additions (id — name — ly — mag):`);
  for (const a of additions) console.log(`  ${a.id}  ${a.name}  ${a.distanceLy}ly  m${a.appMag}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
