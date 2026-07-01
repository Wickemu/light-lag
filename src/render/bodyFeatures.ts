/**
 * Real surface-feature tables — the Jupiter-spot method generalised to geography.
 *
 * Each entry is a small list of a body's recognisable, named features at their
 * REAL coordinates (IAU planetary nomenclature, USGS Gazetteer of Planetary
 * Nomenclature), which bodyTextures.paintFeatures stamps over the procedural base.
 * Same contract as earthLand.ts: real data, drawn procedurally, zero image assets.
 *
 * Coordinates are EAST-POSITIVE degrees, lon ∈ [-180,180], lat ∈ [-90,90]; angular
 * semi-axes in degrees ≈ (feature_diameter_km / body_radius_km) · (180/π) / 2. Most
 * bodies' gazetteers quote WEST longitude, converted here to east-positive. The
 * prime-meridian offset is cosmetic (the body spins in-sim); RELATIVE placement is
 * what carries the likeness, and that is what was fact-checked.
 *
 * Tone is relative to each body's base colour unless `toneHex` pins an absolute hue.
 * `alpha`/`softness` are tuned per feature so relief reads through the stamps.
 */

import type { SurfaceFeature } from "./bodyTextures.ts";

export const BODY_FEATURES: Record<string, SurfaceFeature[]> = {
  // ── Mercury ──────────────────────────────────────────────────────────────────
  // A dark warm-grey world (the rockyBody base) with a real two-terrain story: an
  // ancient, cratered, faintly-browner southern highland vs the younger, smoother,
  // slightly-brighter northern volcanic plains (Borealis Planitia); the vast Caloris
  // impact basin with its bright smooth fill and Montes rim; a handful of subdued
  // older basins and young peak-ring basins; and the eye-catching bright ray craters
  // (Kuiper, Debussy, Hokusai) as a soft splash + crisp core. East-positive planeto-
  // centric longitude; west-lon gazetteer values converted via lonE = 360 − lonW.
  // Source: USGS Gazetteer / MESSENGER.
  mercury: [
    // Terrain dichotomy (broad, very soft, low alpha) — under everything else.
    { name: "Intercrater highlands", kind: "region", shape: "cap", capEdgeLatDeg: -25, tone: "slightly_darker", toneHex: 0x7c6f62, alpha: 0.22, softness: 1 },
    { name: "Borealis Planitia", kind: "smooth_plains", shape: "cap", capEdgeLatDeg: 58, tone: "slightly_brighter", toneHex: 0x9a9086, alpha: 0.3, softness: 0.9 },
    { name: "Northern smooth plains", kind: "smooth_plains", shape: "ellipse", lon: 30, lat: 66, semiMajorDeg: 58, semiMinorDeg: 22, tone: "slightly_brighter", toneHex: 0x968c81, alpha: 0.28, softness: 0.9 },
    // Caloris Planitia (~1550 km, 30.5N/162.7E): bright smooth fill + a subtly darker rim ring.
    { name: "Caloris rim", kind: "basin_ring", shape: "ellipse", lon: 162.7, lat: 31.5, semiMajorDeg: 21, semiMinorDeg: 21, tone: "slightly_darker", toneHex: 0x82766a, alpha: 0.3, softness: 0.45 },
    { name: "Caloris Planitia", kind: "impact_basin_fill", shape: "ellipse", lon: 162.7, lat: 31.5, semiMajorDeg: 18, semiMinorDeg: 18, tone: "brighter", toneHex: 0xac9e8c, alpha: 0.55, softness: 0.7 },
    // Older subdued basins.
    { name: "Rembrandt", kind: "impact_basin_fill", shape: "ellipse", lon: 87.9, lat: -32.9, semiMajorDeg: 8.4, semiMinorDeg: 8.4, tone: "slightly_brighter", toneHex: 0x8f8478, alpha: 0.4, softness: 0.7 },
    { name: "Beethoven", kind: "impact_basin_fill", shape: "ellipse", lon: -124, lat: -20, semiMajorDeg: 7.3, semiMinorDeg: 7.3, tone: "slightly_darker", toneHex: 0x7d7165, alpha: 0.4, softness: 0.7 },
    { name: "Tolstoj", kind: "impact_basin_fill", shape: "ellipse", lon: -163.5, lat: -16.3, semiMajorDeg: 4.2, semiMinorDeg: 4.2, tone: "darker", toneHex: 0x726658, alpha: 0.45, softness: 0.6 },
    // Young peak-ring basins with bright smooth floors.
    { name: "Raditladi", kind: "peak_ring_basin", shape: "ellipse", lon: 119.1, lat: 27.2, semiMajorDeg: 3.1, semiMinorDeg: 3.1, tone: "slightly_brighter", toneHex: 0x8d8377, alpha: 0.4, softness: 0.55 },
    { name: "Rachmaninoff", kind: "peak_ring_basin", shape: "ellipse", lon: 57.4, lat: 27.6, semiMajorDeg: 3.4, semiMinorDeg: 3.4, tone: "brighter", toneHex: 0x968b7d, alpha: 0.45, softness: 0.55 },
    // Bright rayed young craters: a soft feathered halo + a crisp bright core.
    { name: "Hokusai rays", kind: "ray_system", shape: "ellipse", lon: 16.8, lat: 57.8, semiMajorDeg: 26, semiMinorDeg: 19, tone: "brighter", toneHex: 0xc2b5a5, alpha: 0.42, softness: 1 },
    { name: "Hokusai", kind: "rayed_crater", shape: "ellipse", lon: 16.8, lat: 57.8, semiMajorDeg: 1.12, semiMinorDeg: 1.12, tone: "much_brighter", toneHex: 0xdccfbe, alpha: 0.82, softness: 0.35 },
    { name: "Debussy rays", kind: "ray_system", shape: "ellipse", lon: -12.5, lat: -33.9, semiMajorDeg: 13, semiMinorDeg: 8.5, orientationDeg: 75, tone: "brighter", toneHex: 0xbcafa0, alpha: 0.4, softness: 1 },
    { name: "Debussy", kind: "rayed_crater", shape: "ellipse", lon: -12.5, lat: -33.9, semiMajorDeg: 1.0, semiMinorDeg: 1.0, tone: "much_brighter", toneHex: 0xd8cdbd, alpha: 0.8, softness: 0.35 },
    { name: "Kuiper rays", kind: "ray_system", shape: "ellipse", lon: -31.25, lat: -11.35, semiMajorDeg: 8.5, semiMinorDeg: 7, orientationDeg: 20, tone: "brighter", toneHex: 0xbdb0a0, alpha: 0.4, softness: 1 },
    { name: "Kuiper", kind: "rayed_crater", shape: "ellipse", lon: -31.25, lat: -11.35, semiMajorDeg: 0.73, semiMinorDeg: 0.73, tone: "much_brighter", toneHex: 0xd8cdbd, alpha: 0.8, softness: 0.35 },
    { name: "Han Kan rays", kind: "ray_system", shape: "ellipse", lon: -146.4, lat: -72.13, semiMajorDeg: 8, semiMinorDeg: 6, tone: "brighter", toneHex: 0xbcafa0, alpha: 0.38, softness: 1 },
    { name: "Han Kan", kind: "rayed_crater", shape: "ellipse", lon: -146.4, lat: -72.13, semiMajorDeg: 0.59, semiMinorDeg: 0.59, tone: "much_brighter", toneHex: 0xd8cdbd, alpha: 0.78, softness: 0.35 },
  ],

  // ── The Moon ───────────────────────────────────────────────────────────────
  // The near-side "Man in the Moon": dark basaltic maria on the Earth-facing
  // hemisphere (lon ≈ -70..+60) over bright highlands, plus three bright ray
  // craters. Far side (lon ≈ ±180) stays bright highland. Selenographic system is
  // already east-positive (IAU 1961). Source: USGS Gazetteer.
  moon: [
    { name: "Oceanus Procellarum", kind: "mare", shape: "ellipse", lon: -57, lat: 23, semiMajorDeg: 42, semiMinorDeg: 26, orientationDeg: 75, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.8, softness: 0.6 },
    { name: "Mare Imbrium", kind: "mare", shape: "ellipse", lon: -15.6, lat: 32.8, semiMajorDeg: 18.9, semiMinorDeg: 16, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.85, softness: 0.5 },
    { name: "Mare Serenitatis", kind: "mare", shape: "ellipse", lon: 17.5, lat: 28, semiMajorDeg: 11.7, semiMinorDeg: 10, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.85, softness: 0.5 },
    { name: "Mare Tranquillitatis", kind: "mare", shape: "ellipse", lon: 31, lat: 8.5, semiMajorDeg: 15, semiMinorDeg: 11, orientationDeg: -25, tone: "much_darker", toneHex: 0x363842, alpha: 0.85, softness: 0.5 },
    { name: "Mare Crisium", kind: "mare", shape: "ellipse", lon: 59.1, lat: 17, semiMajorDeg: 10, semiMinorDeg: 7.5, orientationDeg: 80, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.88, softness: 0.45 },
    { name: "Mare Fecunditatis", kind: "mare", shape: "ellipse", lon: 51.3, lat: -7.8, semiMajorDeg: 15, semiMinorDeg: 12, orientationDeg: 10, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.82, softness: 0.55 },
    { name: "Mare Nectaris", kind: "mare", shape: "ellipse", lon: 35.5, lat: -15.2, semiMajorDeg: 5.5, semiMinorDeg: 5, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.85, softness: 0.5 },
    { name: "Mare Frigoris", kind: "mare", shape: "ellipse", lon: 1.4, lat: 56, semiMajorDeg: 26, semiMinorDeg: 4.5, tone: "much_darker", toneHex: 0x3c3c3e, alpha: 0.78, softness: 0.6 },
    { name: "Mare Humorum", kind: "mare", shape: "ellipse", lon: -38.6, lat: -24.4, semiMajorDeg: 6.4, semiMinorDeg: 6, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.85, softness: 0.5 },
    { name: "Mare Nubium", kind: "mare", shape: "ellipse", lon: -16.5, lat: -21.3, semiMajorDeg: 11.8, semiMinorDeg: 9, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.82, softness: 0.55 },
    { name: "Mare Cognitum", kind: "mare", shape: "ellipse", lon: -22.2, lat: -10.5, semiMajorDeg: 6, semiMinorDeg: 5, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.8, softness: 0.55 },
    { name: "Mare Vaporum", kind: "mare", shape: "ellipse", lon: 3.6, lat: 13.3, semiMajorDeg: 4, semiMinorDeg: 3.5, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.82, softness: 0.55 },
    // Ray systems: a bright core + wide feathered halo (rays approximated). Last, on top.
    { name: "Tycho", kind: "ray_system", shape: "ellipse", lon: -11.2, lat: -43.3, semiMajorDeg: 45, semiMinorDeg: 45, tone: "much_brighter", toneHex: 0xe8e6e0, alpha: 0.4, softness: 0.92 },
    { name: "Copernicus", kind: "ray_system", shape: "ellipse", lon: -20.1, lat: 9.6, semiMajorDeg: 12, semiMinorDeg: 12, tone: "brighter", toneHex: 0xdcdad4, alpha: 0.4, softness: 0.88 },
    { name: "Aristarchus", kind: "ray_system", shape: "ellipse", lon: -47.4, lat: 23.7, semiMajorDeg: 6, semiMinorDeg: 6, tone: "much_brighter", toneHex: 0xefe9e2, alpha: 0.55, softness: 0.8 },
    // Far side: brighter, near mare-free anorthosite (a subtle hemisphere lift about
    // the anti-Earth point), with the giant South Pole–Aitken basin reading as a
    // relative dark low on top of it — the largest, oldest basin in the solar system.
    { name: "Far-side highlands", kind: "highland", shape: "hemisphere", hemisphereCenterLonDeg: 180, tone: "slightly_brighter", toneHex: 0xcfc9be, alpha: 0.16 },
    { name: "South Pole-Aitken", kind: "basin", shape: "ellipse", lon: 169, lat: -53, semiMajorDeg: 41, semiMinorDeg: 34, tone: "slightly_darker", toneHex: 0x4a4a4d, alpha: 0.4, softness: 0.9 },
    // Eastern-limb / far-side maria completing the pattern (all |lon| ≥ 68, so the
    // near-side "Man in the Moon" cluster is untouched).
    { name: "Mare Marginis", kind: "mare", shape: "ellipse", lon: 87, lat: 13.3, semiMajorDeg: 6, semiMinorDeg: 5, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.78, softness: 0.55 },
    { name: "Mare Smythii", kind: "mare", shape: "ellipse", lon: 87.5, lat: -1.3, semiMajorDeg: 8, semiMinorDeg: 7, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.78, softness: 0.55 },
    { name: "Mare Humboldtianum", kind: "mare", shape: "ellipse", lon: 81.5, lat: 56.8, semiMajorDeg: 5.5, semiMinorDeg: 5, tone: "much_darker", toneHex: 0x3a3a3c, alpha: 0.78, softness: 0.55 },
    { name: "Mare Australe", kind: "mare", shape: "ellipse", lon: 93, lat: -38.9, semiMajorDeg: 9, semiMinorDeg: 8, tone: "darker", toneHex: 0x3c3c3e, alpha: 0.62, softness: 0.65 },
    { name: "Grimaldi", kind: "mare", shape: "ellipse", lon: -68.7, lat: -5.5, semiMajorDeg: 3.6, semiMinorDeg: 3.3, tone: "much_darker", toneHex: 0x38383a, alpha: 0.85, softness: 0.45 },
    // Further bright ray craters (Kepler & Byrgius A on the near side, Jackson on the far).
    { name: "Kepler", kind: "ray_system", shape: "ellipse", lon: -38, lat: 8.1, semiMajorDeg: 7, semiMinorDeg: 7, tone: "brighter", toneHex: 0xdcdad4, alpha: 0.4, softness: 0.86 },
    { name: "Byrgius A", kind: "ray_system", shape: "ellipse", lon: -63.7, lat: -24.6, semiMajorDeg: 6, semiMinorDeg: 6, tone: "much_brighter", toneHex: 0xe8e6e0, alpha: 0.42, softness: 0.85 },
    { name: "Jackson", kind: "ray_system", shape: "ellipse", lon: -163.1, lat: 22.4, semiMajorDeg: 9, semiMinorDeg: 9, tone: "much_brighter", toneHex: 0xe8e6e0, alpha: 0.42, softness: 0.88 },
  ],

  // ── Mars ───────────────────────────────────────────────────────────────────
  // Dusky albedo maria in the southern equatorial belt over the ochre base; the
  // dark Syrtis Major / bright Hellas pairing at ~70E is the key cue. Soft, diffuse
  // edges (Mars albedo is gradational). West-longitude gazetteer values converted
  // to east-positive. Source: USGS Gazetteer / Mars quadrangles.
  mars: [
    // Bright regions first (broad, very soft).
    { name: "Arabia Terra", kind: "region", shape: "ellipse", lon: 30, lat: 20, semiMajorDeg: 30, semiMinorDeg: 22, tone: "brighter", toneHex: 0xcc9a6e, alpha: 0.28, softness: 0.85 },
    { name: "Tharsis", kind: "region", shape: "ellipse", lon: -95, lat: 0, semiMajorDeg: 38, semiMinorDeg: 28, tone: "slightly_brighter", toneHex: 0xc89a72, alpha: 0.25, softness: 0.88 },
    { name: "Elysium", kind: "region", shape: "ellipse", lon: 147, lat: 25, semiMajorDeg: 17, semiMinorDeg: 13, tone: "slightly_brighter", toneHex: 0xc89a72, alpha: 0.25, softness: 0.85 },
    { name: "Hellas Planitia", kind: "basin", shape: "ellipse", lon: 70.5, lat: -42.4, semiMajorDeg: 19.4, semiMinorDeg: 17.5, tone: "brighter", toneHex: 0xdcb488, alpha: 0.42, softness: 0.75 },
    // Dark albedo maria (the recognisable "continents").
    { name: "Syrtis Major Planum", kind: "albedo_dark", shape: "ellipse", lon: 69.5, lat: 8.4, semiMajorDeg: 12.7, semiMinorDeg: 8.5, orientationDeg: -20, tone: "much_darker", toneHex: 0x5a4b3a, alpha: 0.62, softness: 0.55 },
    { name: "Sinus Sabaeus", kind: "albedo_dark", shape: "ellipse", lon: 20, lat: -9, semiMajorDeg: 15, semiMinorDeg: 5, orientationDeg: -8, tone: "darker", toneHex: 0x6a5847, alpha: 0.55, softness: 0.6 },
    { name: "Sinus Meridiani", kind: "albedo_dark", shape: "ellipse", lon: -0.5, lat: -2, semiMajorDeg: 8.5, semiMinorDeg: 4.5, tone: "darker", toneHex: 0x6a5847, alpha: 0.55, softness: 0.6 },
    { name: "Mare Erythraeum", kind: "albedo_dark", shape: "ellipse", lon: -40, lat: -25, semiMajorDeg: 18.5, semiMinorDeg: 12, tone: "darker", toneHex: 0x62513f, alpha: 0.55, softness: 0.62 },
    { name: "Margaritifer Sinus", kind: "albedo_dark", shape: "ellipse", lon: -25, lat: -10, semiMajorDeg: 8.5, semiMinorDeg: 5, tone: "darker", toneHex: 0x665645, alpha: 0.55, softness: 0.6 },
    { name: "Solis Lacus", kind: "albedo_dark", shape: "ellipse", lon: -89.7, lat: -26, semiMajorDeg: 7, semiMinorDeg: 6, tone: "much_darker", toneHex: 0x574838, alpha: 0.6, softness: 0.55 },
    { name: "Mare Tyrrhenum", kind: "albedo_dark", shape: "ellipse", lon: 105, lat: -20, semiMajorDeg: 14, semiMinorDeg: 8, orientationDeg: 10, tone: "darker", toneHex: 0x5f4f3e, alpha: 0.55, softness: 0.6 },
    { name: "Mare Cimmerium", kind: "albedo_dark", shape: "ellipse", lon: 140, lat: -22, semiMajorDeg: 16, semiMinorDeg: 9, orientationDeg: 5, tone: "darker", toneHex: 0x5f4f3e, alpha: 0.55, softness: 0.6 },
    { name: "Mare Sirenum", kind: "albedo_dark", shape: "ellipse", lon: -150, lat: -30, semiMajorDeg: 16, semiMinorDeg: 9, orientationDeg: -5, tone: "darker", toneHex: 0x5f4f3e, alpha: 0.55, softness: 0.6 },
    { name: "Acidalia Planitia", kind: "albedo_dark", shape: "ellipse", lon: -20.7, lat: 49.8, semiMajorDeg: 25, semiMinorDeg: 16, orientationDeg: -25, tone: "darker", toneHex: 0x5d4d3d, alpha: 0.5, softness: 0.65 },
    // Valles Marineris — the deep dark canyon system: the Noctis Labyrinthus tangle
    // at the Tharsis end, the Melas/Coprates trunk, the Ius/Tithonium north wall, and
    // the Capri/Eos chaos flaring east.
    { name: "Valles Marineris", kind: "linea", shape: "polyline", polyline: [-100, -9, -92, -9, -85, -11, -75, -12, -65, -13, -55, -13, -45, -14, -35, -15, -28, -13], tone: "much_darker", toneHex: 0x483a2b, alpha: 0.6, strokeWidthDeg: 3.8 },
    { name: "Noctis Labyrinthus", kind: "linea", shape: "polyline", polyline: [-110, -6, -105, -9, -102, -11, -106, -8, -100, -10], tone: "much_darker", toneHex: 0x483a2b, alpha: 0.5, strokeWidthDeg: 3.0 },
    { name: "Ius/Tithonium Chasmata", kind: "linea", shape: "polyline", polyline: [-92, -6, -82, -7, -72, -8], tone: "darker", toneHex: 0x4f4030, alpha: 0.45, strokeWidthDeg: 2.2 },
    { name: "Capri/Eos Chaos", kind: "linea", shape: "polyline", polyline: [-40, -14, -32, -11, -25, -8, -20, -4], tone: "much_darker", toneHex: 0x4a3c2d, alpha: 0.5, strokeWidthDeg: 3.4 },
    // Tharsis volcanoes — bright raised shields (relief via the "mountain" bump) each
    // capped by a small crisp dark caldera. Olympus, the Ascraeus→Pavonis→Arsia line,
    // and the vast low Alba Mons to the north.
    { name: "Olympus Mons", kind: "mountain", shape: "ellipse", lon: -133.8, lat: 18.4, semiMajorDeg: 4.2, semiMinorDeg: 4.2, tone: "brighter", toneHex: 0xd0a67c, alpha: 0.45, softness: 0.7 },
    { name: "Olympus caldera", kind: "caldera", shape: "ellipse", lon: -133.8, lat: 18.4, semiMajorDeg: 0.55, semiMinorDeg: 0.55, tone: "much_darker", toneHex: 0x4a3a2c, alpha: 0.7, softness: 0.2 },
    { name: "Ascraeus Mons", kind: "mountain", shape: "ellipse", lon: -104.5, lat: 11.8, semiMajorDeg: 2.4, semiMinorDeg: 2.4, tone: "brighter", toneHex: 0xcea478, alpha: 0.42, softness: 0.68 },
    { name: "Ascraeus caldera", kind: "caldera", shape: "ellipse", lon: -104.5, lat: 11.8, semiMajorDeg: 0.5, semiMinorDeg: 0.5, tone: "much_darker", toneHex: 0x4a3a2c, alpha: 0.65, softness: 0.2 },
    { name: "Pavonis Mons", kind: "mountain", shape: "ellipse", lon: -113.0, lat: 0.8, semiMajorDeg: 2.1, semiMinorDeg: 2.1, tone: "brighter", toneHex: 0xcea478, alpha: 0.42, softness: 0.68 },
    { name: "Pavonis caldera", kind: "caldera", shape: "ellipse", lon: -113.0, lat: 0.8, semiMajorDeg: 0.45, semiMinorDeg: 0.45, tone: "much_darker", toneHex: 0x4a3a2c, alpha: 0.65, softness: 0.2 },
    { name: "Arsia Mons", kind: "mountain", shape: "ellipse", lon: -120.5, lat: -8.4, semiMajorDeg: 2.5, semiMinorDeg: 2.5, tone: "brighter", toneHex: 0xcea478, alpha: 0.42, softness: 0.68 },
    { name: "Arsia caldera", kind: "caldera", shape: "ellipse", lon: -120.5, lat: -8.4, semiMajorDeg: 0.55, semiMinorDeg: 0.55, tone: "much_darker", toneHex: 0x4a3a2c, alpha: 0.65, softness: 0.2 },
    { name: "Alba Mons", kind: "mountain", shape: "ellipse", lon: -109.6, lat: 40.5, semiMajorDeg: 7.5, semiMinorDeg: 6.0, tone: "slightly_brighter", toneHex: 0xc9a077, alpha: 0.26, softness: 0.85 },
    // Argyre basin (bright dusty southern low; Hellas is refined in the bright block above).
    { name: "Argyre Planitia", kind: "basin", shape: "ellipse", lon: -44.0, lat: -49.7, semiMajorDeg: 10.5, semiMinorDeg: 9.5, tone: "brighter", toneHex: 0xd8ad80, alpha: 0.4, softness: 0.72 },
    // Polar caps — a wide dust-frost seasonal ring, a bright crisp residual core, and
    // dark spiral troughs cut into the ice. North: water ice, larger, whiter, notched
    // by Chasma Boreale. South: CO₂ ice, smaller, offset ~4° from the pole toward lon 0.
    { name: "North seasonal cap", kind: "polar", shape: "cap", capEdgeLatDeg: 68, tone: "much_brighter", toneHex: 0xe8ddd2, alpha: 0.5, softness: 0.85 },
    { name: "North residual cap", kind: "polar", shape: "cap", capEdgeLatDeg: 80, tone: "much_brighter", toneHex: 0xf2f0ec, alpha: 0.9, softness: 0.4 },
    { name: "Chasma Boreale", kind: "linea", shape: "polyline", polyline: [-25, 88, -20, 84, -18, 81, -16, 79], tone: "much_darker", toneHex: 0xa8906f, alpha: 0.55, strokeWidthDeg: 2.4 },
    { name: "N spiral trough A", kind: "linea", shape: "polyline", polyline: [0, 87, 40, 85, 90, 83, 140, 82, 180, 81.5], tone: "darker", toneHex: 0xb9a288, alpha: 0.45, strokeWidthDeg: 1.4 },
    { name: "N spiral trough B", kind: "linea", shape: "polyline", polyline: [120, 86, 160, 84, -160, 82.5, -120, 81.5, -90, 81], tone: "darker", toneHex: 0xb9a288, alpha: 0.4, strokeWidthDeg: 1.3 },
    { name: "South seasonal cap", kind: "polar", shape: "cap", capEdgeLatDeg: -68, tone: "much_brighter", toneHex: 0xe8ddd2, alpha: 0.46, softness: 0.85 },
    { name: "South residual cap", kind: "polar", shape: "cap", capEdgeLatDeg: -84, tone: "much_brighter", toneHex: 0xf4f1ea, alpha: 0.9, softness: 0.4 },
    { name: "South cap offset", kind: "polar", shape: "ellipse", lon: 0, lat: -86, semiMajorDeg: 6, semiMinorDeg: 6, tone: "much_brighter", toneHex: 0xf4f1ea, alpha: 0.6, softness: 0.5 },
    { name: "S spiral trough A", kind: "linea", shape: "polyline", polyline: [10, -86, 50, -84, 100, -82.5, 150, -81.5, -170, -81], tone: "darker", toneHex: 0xb9a288, alpha: 0.42, strokeWidthDeg: 1.3 },
    { name: "S spiral trough B", kind: "linea", shape: "polyline", polyline: [-40, -85, 0, -83, 60, -82, 120, -81.5], tone: "darker", toneHex: 0xb9a288, alpha: 0.4, strokeWidthDeg: 1.2 },
  ],

  // ── Pluto ──────────────────────────────────────────────────────────────────
  // New Horizons' encounter face: the bright nitrogen-ice "heart" (Tombaugh Regio /
  // Sputnik Planitia) near lon ~178E, the dark reddish "whale" Cthulhu Macula to its
  // WEST (~90E), a yellowish north polar cap, mottled tan elsewhere. Pluto's system
  // is already east-positive. Source: USGS Gazetteer (Pluto).
  pluto: [
    // Broad regional terrae (soft, low-contrast).
    { name: "Vega Terra", kind: "region", shape: "ellipse", lon: 85.49, lat: 33.96, semiMajorDeg: 38.9, semiMinorDeg: 26, tone: "slightly_brighter", toneHex: 0xc3aa84, alpha: 0.25, softness: 0.85 },
    { name: "Hayabusa Terra", kind: "region", shape: "ellipse", lon: -130.12, lat: 46.07, semiMajorDeg: 26.9, semiMinorDeg: 20, tone: "neutral", toneHex: 0xbda07e, alpha: 0.3, softness: 0.8 },
    { name: "Pioneer Terra", kind: "region", shape: "ellipse", lon: -167.6, lat: 56.58, semiMajorDeg: 14.4, semiMinorDeg: 12, tone: "neutral", toneHex: 0xb59778, alpha: 0.3, softness: 0.8 },
    { name: "Tartarus Dorsa", kind: "region", shape: "ellipse", lon: -126.91, lat: 8.5, semiMajorDeg: 20.5, semiMinorDeg: 12, tone: "slightly_brighter", toneHex: 0xcdb89a, alpha: 0.3, softness: 0.8 },
    { name: "Lowell Regio", kind: "region", shape: "cap", capEdgeLatDeg: 68, tone: "slightly_brighter", toneHex: 0xc9b48c, alpha: 0.45 },
    // Dark reddish maculae.
    { name: "Cthulhu Macula", kind: "macula", shape: "ellipse", lon: 91.42, lat: -9.21, semiMajorDeg: 78.5, semiMinorDeg: 24, orientationDeg: -5, tone: "much_darker", toneHex: 0x5a4434, alpha: 0.62, softness: 0.55 },
    { name: "Krun Macula", kind: "macula", shape: "ellipse", lon: -150.51, lat: -13.36, semiMajorDeg: 14, semiMinorDeg: 10, tone: "much_darker", toneHex: 0x54402f, alpha: 0.6, softness: 0.55 },
    // The bright heart, last and on top.
    { name: "Tombaugh Regio", kind: "albedo_bright", shape: "ellipse", lon: -176.78, lat: 7.62, semiMajorDeg: 55.4, semiMinorDeg: 40, orientationDeg: 15, tone: "much_brighter", toneHex: 0xe8e3d8, alpha: 0.82, softness: 0.5 },
    { name: "Sputnik Planitia", kind: "basin", shape: "ellipse", lon: 178.69, lat: 19.51, semiMajorDeg: 35.96, semiMinorDeg: 30, tone: "much_brighter", toneHex: 0xf0ece2, alpha: 0.9, softness: 0.45 },
    // Sputnik-shore mountains and a southern cryovolcano.
    { name: "Tenzing Montes", kind: "mountain", shape: "ellipse", lon: 177.38, lat: -15.61, semiMajorDeg: 6.8, semiMinorDeg: 5, tone: "brighter", toneHex: 0xddd2c0, alpha: 0.5, softness: 0.6 },
    { name: "Hillary Montes", kind: "mountain", shape: "ellipse", lon: 169.58, lat: 3.26, semiMajorDeg: 9.35, semiMinorDeg: 6, tone: "brighter", toneHex: 0xd8ccb8, alpha: 0.45, softness: 0.6 },
    { name: "Wright Mons", kind: "patera", shape: "ellipse", lon: 173.24, lat: -21.36, semiMajorDeg: 3.98, semiMinorDeg: 3.98, tone: "slightly_darker", toneHex: 0xa08a6e, alpha: 0.45, softness: 0.6 },
  ],

  // ── Iapetus ────────────────────────────────────────────────────────────────
  // Saturn's two-tone moon: dark reddish Cassini Regio coats the LEADING hemisphere
  // (apex ≈ -90E), bright icy terrae fill the trailing side, a thin dark equatorial
  // ridge runs through the dark face. Highest albedo contrast in the solar system.
  // West-longitude gazetteer values converted to east-positive. Source: USGS Gazetteer.
  iapetus: [
    // The two-tone dichotomy modelled as opposing hemispheres so neither bleeds
    // across the boundary meridians: dark Cassini Regio on the leading apex (-90),
    // bright icy terrae (Roncevaux/Saragossa) on the trailing apex (+90).
    { name: "Trailing bright terrae", kind: "albedo_bright", shape: "hemisphere", hemisphereCenterLonDeg: 90, tone: "much_brighter", toneHex: 0xdcd6c8, alpha: 0.85 },
    { name: "Cassini Regio", kind: "albedo_dark", shape: "hemisphere", hemisphereCenterLonDeg: -90, tone: "much_darker", toneHex: 0x342618, alpha: 0.95 },
    { name: "Equatorial ridge", kind: "linea", shape: "polyline", polyline: [-64.7, 0, -100, 1.5, -136, 0, -170, -1, 180, 0.5, 160, 1, 143.3, 0], tone: "much_darker", toneHex: 0x241a12, alpha: 0.7, strokeWidthDeg: 1.6 },
    { name: "Turgis", kind: "basin", shape: "ellipse", lon: -28.4, lat: 16.9, semiMajorDeg: 40.7, semiMinorDeg: 40.7, tone: "slightly_brighter", toneHex: 0x6a5a48, alpha: 0.25, softness: 0.75 },
    { name: "Engelier", kind: "basin", shape: "ellipse", lon: 95.3, lat: -40.5, semiMajorDeg: 35.4, semiMinorDeg: 35.4, tone: "slightly_darker", toneHex: 0xb6b0a2, alpha: 0.3, softness: 0.7 },
    { name: "Gerin", kind: "basin", shape: "ellipse", lon: 127, lat: -45.6, semiMajorDeg: 31.2, semiMinorDeg: 31.2, tone: "slightly_darker", toneHex: 0xb6b0a2, alpha: 0.25, softness: 0.7 },
  ],

  // ── Europa ─────────────────────────────────────────────────────────────────
  // Bright water-ice globe webbed with reddish-brown lineae (cracks/bands) and two
  // reddish chaos maculae near the ±180 seam. Almost no relief or craters. Agenor is
  // a BRIGHT band, not dark. West-positive gazetteer converted to east-positive.
  // Source: USGS Gazetteer + Johnston's Archive.
  europa: [
    { name: "Bright water-ice base", kind: "albedo_bright", shape: "global", tone: "brighter", toneHex: 0xd4ccbd, alpha: 0.55 },
    { name: "Agenor Linea", kind: "linea", shape: "polyline", polyline: [108.5, -44.8, 127.5, -45.2, 146.5, -45, 165.5, -44.2, -175.5, -42.8], tone: "slightly_brighter", toneHex: 0xcdbfa6, alpha: 0.6, strokeWidthDeg: 1.8 },
    { name: "Belus Linea", kind: "linea", shape: "polyline", polyline: [83.4, 8.5, 107.6, 11.3, 131.7, 13.3, 155.8, 14.6, 180, 15.1], tone: "slightly_darker", toneHex: 0x9a6f55, alpha: 0.5, strokeWidthDeg: 1.6 },
    { name: "Cadmus Linea", kind: "linea", shape: "polyline", polyline: [162.1, 23.9, 174.5, 26.6, -173.1, 28.8, -160.7, 30.5, -148.3, 31.7], tone: "slightly_darker", toneHex: 0x8f6750, alpha: 0.5, strokeWidthDeg: 1.5 },
    { name: "Minos Linea", kind: "linea", shape: "polyline", polyline: [109.2, 39.8, 136.7, 43.5, 164.3, 46.5, -168.1, 48.9, -140.6, 50.8], tone: "slightly_darker", toneHex: 0x9a6f55, alpha: 0.5, strokeWidthDeg: 1.6 },
    { name: "Phineus Linea", kind: "linea", shape: "polyline", polyline: [47.5, -30.5, 69.1, -32.9, 90.8, -34.5, 112.5, -35.4, 134.1, -35.5], tone: "slightly_darker", toneHex: 0x8f6750, alpha: 0.5, strokeWidthDeg: 1.5 },
    { name: "Astypalaea Linea", kind: "linea", shape: "polyline", polyline: [58.8, -75.5, 99.3, -76.6, 139.7, -77.3, -179.9, -77.6, -139.4, -77.5], tone: "slightly_darker", toneHex: 0x8a6248, alpha: 0.45, strokeWidthDeg: 1.4 },
    { name: "Libya Linea", kind: "linea", shape: "polyline", polyline: [161.8, -56.2, 169.2, -56.5, 176.7, -56.6, -175.8, -56.5, -168.4, -56.2], tone: "slightly_darker", toneHex: 0x8f6750, alpha: 0.45, strokeWidthDeg: 1.4 },
    { name: "Thynia Linea", kind: "linea", shape: "polyline", polyline: [-162.3, -57.9, -155.5, -57.6, -148.6, -57.5, -141.7, -57.6, -134.9, -57.9], tone: "slightly_darker", toneHex: 0x8a6248, alpha: 0.45, strokeWidthDeg: 1.4 },
    { name: "Argiope Linea", kind: "linea", shape: "polyline", polyline: [140.5, -9.1, 149.2, -9.2, 157.8, -9, 166.4, -8.4, 175.1, -7.3], tone: "slightly_darker", toneHex: 0x92694f, alpha: 0.5, strokeWidthDeg: 1.4 },
    { name: "Harmonia Linea", kind: "linea", shape: "polyline", polyline: [173.2, 24.1, -177.4, 26.2, -168, 27.9, -158.6, 29.1, -149.2, 29.9], tone: "slightly_darker", toneHex: 0x92694f, alpha: 0.5, strokeWidthDeg: 1.4 },
    { name: "Sidon Flexus", kind: "linea", shape: "polyline", polyline: [137.8, -64.5, 163.7, -65.8, -170.4, -66.3, -144.5, -65.8, -118.6, -64.5], tone: "slightly_darker", toneHex: 0x8a6248, alpha: 0.45, strokeWidthDeg: 1.4 },
    { name: "Thera Macula", kind: "macula", shape: "ellipse", lon: 178.8, lat: -46.7, semiMajorDeg: 1.75, semiMinorDeg: 1.4, orientationDeg: 20, tone: "darker", toneHex: 0x6e4632, alpha: 0.6, softness: 0.6 },
    { name: "Thrace Macula", kind: "macula", shape: "ellipse", lon: -172.1, lat: -45.9, semiMajorDeg: 3.31, semiMinorDeg: 2.6, orientationDeg: 30, tone: "darker", toneHex: 0x6e4632, alpha: 0.6, softness: 0.6 },
  ],

  // ── Io ─────────────────────────────────────────────────────────────────────
  // The volcanic "pizza moon": a yellow-orange sulfur base (the body colour) mottled
  // with dark volcanic paterae and Pele's giant reddish-orange sulfur ring. No impact
  // craters. West-positive gazetteer converted to east-positive. Source: USGS Gazetteer.
  io: [
    { name: "North polar field", kind: "region", shape: "cap", capEdgeLatDeg: 60, tone: "slightly_darker", toneHex: 0x7a6234, alpha: 0.4 },
    { name: "South polar field", kind: "region", shape: "cap", capEdgeLatDeg: -60, tone: "slightly_darker", toneHex: 0x7a6234, alpha: 0.4 },
    { name: "Pele ring", kind: "ray_system", shape: "ellipse", lon: 104.7, lat: -18.7, semiMajorDeg: 20.4, semiMinorDeg: 20.4, tone: "neutral", toneHex: 0xb8442f, alpha: 0.5, softness: 0.85 },
    { name: "Loki Patera", kind: "patera", shape: "ellipse", lon: 51.2, lat: 13, semiMajorDeg: 3.2, semiMinorDeg: 3.2, tone: "much_darker", toneHex: 0x241a12, alpha: 0.75, softness: 0.5 },
    { name: "Pele", kind: "patera", shape: "ellipse", lon: 104.7, lat: -18.7, semiMajorDeg: 1, semiMinorDeg: 0.7, tone: "much_darker", toneHex: 0x2a1c14, alpha: 0.85, softness: 0.45 },
    { name: "Pillan Patera", kind: "patera", shape: "ellipse", lon: 116.75, lat: -12.3, semiMajorDeg: 1.15, semiMinorDeg: 1.15, tone: "much_darker", toneHex: 0x2b2018, alpha: 0.8, softness: 0.5 },
    { name: "Prometheus", kind: "patera", shape: "ellipse", lon: -153.9, lat: -1.5, semiMajorDeg: 0.9, semiMinorDeg: 0.9, tone: "darker", toneHex: 0x403022, alpha: 0.7, softness: 0.55 },
    { name: "Culann Patera", kind: "patera", shape: "ellipse", lon: -160.2, lat: -20.2, semiMajorDeg: 1.2, semiMinorDeg: 1.2, tone: "darker", toneHex: 0x4a3520, alpha: 0.7, softness: 0.55 },
    { name: "Tupan Patera", kind: "patera", shape: "ellipse", lon: -141.1, lat: -18.7, semiMajorDeg: 1.24, semiMinorDeg: 1.24, tone: "much_darker", toneHex: 0x2e2117, alpha: 0.78, softness: 0.5 },
    { name: "Marduk", kind: "patera", shape: "ellipse", lon: 150.3, lat: -29.5, semiMajorDeg: 0.9, semiMinorDeg: 0.9, tone: "much_darker", toneHex: 0x27201a, alpha: 0.75, softness: 0.5 },
    { name: "Amirani", kind: "patera", shape: "ellipse", lon: -114.7, lat: 24.5, semiMajorDeg: 0.9, semiMinorDeg: 0.9, tone: "darker", toneHex: 0x3a2c1e, alpha: 0.7, softness: 0.55 },
    { name: "Amaterasu Patera", kind: "patera", shape: "ellipse", lon: 53.5, lat: 38.1, semiMajorDeg: 1.46, semiMinorDeg: 1.46, tone: "much_darker", toneHex: 0x2a2017, alpha: 0.78, softness: 0.5 },
    { name: "Dazhbog Patera", kind: "patera", shape: "ellipse", lon: 58.5, lat: 55.1, semiMajorDeg: 1.86, semiMinorDeg: 1.86, tone: "much_darker", toneHex: 0x2c2118, alpha: 0.78, softness: 0.5 },
    { name: "Babbar Patera", kind: "patera", shape: "ellipse", lon: 88, lat: -39.8, semiMajorDeg: 1.35, semiMinorDeg: 1.35, tone: "much_darker", toneHex: 0x291f17, alpha: 0.78, softness: 0.5 },
  ],

  // ── Triton ─────────────────────────────────────────────────────────────────
  // Neptune's moon: a vast pinkish nitrogen-ice SOUTH polar cap with dark plume
  // streaks, bluish-grey "cantaloupe terrain" (Bubembe Regio) in the north, smoother
  // plains (Monad Regio) east. West-positive gazetteer converted to east-positive.
  // Source: USGS Gazetteer (Voyager 2).
  triton: [
    { name: "Bubembe Regio", kind: "region", shape: "ellipse", lon: -25, lat: 18, semiMajorDeg: 42, semiMinorDeg: 30, tone: "slightly_darker", toneHex: 0x9aa6b0, alpha: 0.4, softness: 0.8 },
    { name: "Monad Regio", kind: "region", shape: "ellipse", lon: 37, lat: 20, semiMajorDeg: 45, semiMinorDeg: 32, tone: "neutral", toneHex: 0xaeb4b8, alpha: 0.3, softness: 0.85 },
    { name: "South polar cap", kind: "polar_cap", shape: "cap", capEdgeLatDeg: -15, tone: "much_brighter", toneHex: 0xe8b9a8, alpha: 0.8 },
    { name: "Slidr Sulci", kind: "linea", shape: "polyline", polyline: [-40, 23.5, -10, 23.5, 15, 22], tone: "brighter", toneHex: 0xcfd6db, alpha: 0.45, strokeWidthDeg: 1.2 },
    { name: "Tano Sulci", kind: "linea", shape: "polyline", polyline: [-35, 33.5, -23, 33.5, -8, 30], tone: "brighter", toneHex: 0xcfd6db, alpha: 0.45, strokeWidthDeg: 1.2 },
    { name: "Yenisey Sulci", kind: "linea", shape: "polyline", polyline: [50, 8, 56, 3, 62, -3], tone: "slightly_brighter", toneHex: 0xc2c9cf, alpha: 0.4, strokeWidthDeg: 1.2 },
    { name: "Ruach Planitia", kind: "basin", shape: "ellipse", lon: 24, lat: 28, semiMajorDeg: 8, semiMinorDeg: 7, tone: "slightly_brighter", toneHex: 0xbcc2c6, alpha: 0.3, softness: 0.7 },
    { name: "Tuonela Planitia", kind: "basin", shape: "ellipse", lon: 14.5, lat: 34, semiMajorDeg: 7, semiMinorDeg: 6, tone: "slightly_brighter", toneHex: 0xbcc2c6, alpha: 0.3, softness: 0.7 },
    { name: "Leviathan Patera", kind: "patera", shape: "ellipse", lon: 28.5, lat: 17, semiMajorDeg: 3, semiMinorDeg: 3, tone: "darker", toneHex: 0x7c828a, alpha: 0.5, softness: 0.6 },
    // Dark plume/wind maculae on the pink cap.
    { name: "Zin Maculae", kind: "macula", shape: "ellipse", lon: 68, lat: -24.5, semiMajorDeg: 2.5, semiMinorDeg: 2, orientationDeg: 60, tone: "darker", toneHex: 0x7a5a4e, alpha: 0.6, softness: 0.55 },
    { name: "Akupara Maculae", kind: "macula", shape: "ellipse", lon: 63, lat: -27.5, semiMajorDeg: 2.3, semiMinorDeg: 1.9, orientationDeg: 60, tone: "darker", toneHex: 0x7a5a4e, alpha: 0.6, softness: 0.55 },
    { name: "Viviane Macula", kind: "macula", shape: "ellipse", lon: 36.5, lat: -31, semiMajorDeg: 1.8, semiMinorDeg: 1.5, orientationDeg: 60, tone: "darker", toneHex: 0x80604f, alpha: 0.55, softness: 0.55 },
    { name: "Doro Macula", kind: "macula", shape: "ellipse", lon: 31.7, lat: -27.5, semiMajorDeg: 1.6, semiMinorDeg: 1.3, orientationDeg: 60, tone: "darker", toneHex: 0x80604f, alpha: 0.55, softness: 0.55 },
  ],

  // ── Earth ──────────────────────────────────────────────────────────────────
  // Large-scale tint/relief over the real coastline mask (earthLand.ts): subtropical
  // deserts near ±25°, equatorial rainforest belts, permanent ice sheets, mountain
  // spines. Earth's geographic system is already east-positive. Source: standard
  // physical-geography gazetteer. Stamps may bleed slightly past the coast (reads as
  // shallows / sea ice), which is acceptable.
  earth: [
    // Forests first (equatorial land base).
    { name: "Amazon Rainforest", kind: "forest", shape: "ellipse", lon: -62, lat: -4, semiMajorDeg: 14, semiMinorDeg: 9, tone: "darker", toneHex: 0x2f5226, alpha: 0.5, softness: 0.7 },
    { name: "Congo Rainforest", kind: "forest", shape: "ellipse", lon: 22, lat: -1, semiMajorDeg: 10, semiMinorDeg: 7, tone: "darker", toneHex: 0x30521f, alpha: 0.5, softness: 0.7 },
    { name: "Indonesia Rainforest", kind: "forest", shape: "ellipse", lon: 115, lat: 0, semiMajorDeg: 20, semiMinorDeg: 6, orientationDeg: -15, tone: "darker", toneHex: 0x2e5424, alpha: 0.5, softness: 0.7 },
    // Deserts.
    { name: "Sahara Desert", kind: "desert", shape: "ellipse", lon: 13, lat: 21, semiMajorDeg: 22, semiMinorDeg: 9, tone: "slightly_brighter", toneHex: 0xcdb48a, alpha: 0.5, softness: 0.7 },
    { name: "Arabian Desert", kind: "desert", shape: "ellipse", lon: 46, lat: 23, semiMajorDeg: 9, semiMinorDeg: 7, orientationDeg: -20, tone: "slightly_brighter", toneHex: 0xc8a878, alpha: 0.5, softness: 0.7 },
    { name: "Kalahari & Namib", kind: "desert", shape: "ellipse", lon: 20, lat: -23, semiMajorDeg: 8, semiMinorDeg: 6, orientationDeg: 10, tone: "slightly_brighter", toneHex: 0xc9a470, alpha: 0.45, softness: 0.7 },
    { name: "Gobi & Taklamakan", kind: "desert", shape: "ellipse", lon: 93, lat: 41, semiMajorDeg: 13, semiMinorDeg: 6, orientationDeg: -15, tone: "slightly_brighter", toneHex: 0xcbb084, alpha: 0.45, softness: 0.7 },
    { name: "Australian Outback", kind: "desert", shape: "ellipse", lon: 132, lat: -25, semiMajorDeg: 13, semiMinorDeg: 9, tone: "slightly_brighter", toneHex: 0xc69a5e, alpha: 0.5, softness: 0.7 },
    { name: "Atacama Desert", kind: "desert", shape: "ellipse", lon: -69, lat: -24, semiMajorDeg: 6, semiMinorDeg: 1.5, orientationDeg: 80, tone: "slightly_brighter", toneHex: 0xc4a578, alpha: 0.45, softness: 0.7 },
    { name: "Mojave & Sonoran", kind: "desert", shape: "ellipse", lon: -113, lat: 33, semiMajorDeg: 6, semiMinorDeg: 4, orientationDeg: -30, tone: "slightly_brighter", toneHex: 0xc8a674, alpha: 0.45, softness: 0.7 },
    { name: "Karakum Desert", kind: "desert", shape: "ellipse", lon: 59, lat: 39, semiMajorDeg: 5, semiMinorDeg: 3.5, orientationDeg: -10, tone: "slightly_brighter", toneHex: 0xcab488, alpha: 0.45, softness: 0.7 },
    // Mountain spines (bump relief + faint tint).
    { name: "Himalaya", kind: "mountain", shape: "ellipse", lon: 84, lat: 30, semiMajorDeg: 11, semiMinorDeg: 2.5, orientationDeg: -25, tone: "slightly_brighter", toneHex: 0xb9a88f, alpha: 0.4, softness: 0.65 },
    { name: "Andes", kind: "mountain", shape: "ellipse", lon: -67, lat: -22, semiMajorDeg: 30, semiMinorDeg: 2, orientationDeg: 80, tone: "slightly_brighter", toneHex: 0xb5a085, alpha: 0.4, softness: 0.65 },
    { name: "Rocky Mountains", kind: "mountain", shape: "ellipse", lon: -110, lat: 44, semiMajorDeg: 16, semiMinorDeg: 3, orientationDeg: 70, tone: "slightly_brighter", toneHex: 0xb3a283, alpha: 0.4, softness: 0.65 },
    { name: "Alps", kind: "mountain", shape: "ellipse", lon: 10, lat: 46, semiMajorDeg: 4, semiMinorDeg: 1.5, orientationDeg: 75, tone: "slightly_brighter", toneHex: 0xbcab92, alpha: 0.4, softness: 0.65 },
    // Ice sheets last, opaque.
    { name: "Greenland Ice Sheet", kind: "ice_sheet", shape: "ellipse", lon: -42, lat: 72, semiMajorDeg: 11, semiMinorDeg: 6, tone: "much_brighter", toneHex: 0xf2f6fa, alpha: 0.9, softness: 0.5 },
    { name: "Antarctic Ice Sheet", kind: "ice_sheet", shape: "cap", capEdgeLatDeg: -67, tone: "much_brighter", toneHex: 0xf4f8fc, alpha: 0.95 },
  ],

  // ── Phobos ───────────────────────────────────────────────────────────────────
  // Mars's inner moon: a very dark, densely-cratered carbonaceous body dominated by
  // the giant crater Stickney (~9 km on an ~11 km body — nearly half its width), with
  // the famous family of near-parallel grooves radiating from near it. West-longitude
  // IAU values converted to east-positive via E = ((360 − W) mod 360). Source: USGS
  // Gazetteer (Viking / Mars Express).
  phobos: [
    // Stickney: a huge dark bowl with a slightly-brighter fresher rim (concentric).
    { name: "Stickney", kind: "crater", shape: "ellipse", lon: -49, lat: 1, semiMajorDeg: 23, semiMinorDeg: 22, tone: "much_darker", toneHex: 0x3f3b36, alpha: 0.8, softness: 0.4 },
    { name: "Stickney rim", kind: "crater_rim", shape: "ellipse", lon: -49, lat: 1, semiMajorDeg: 25, semiMinorDeg: 23.6, tone: "slightly_brighter", toneHex: 0x6a655c, alpha: 0.45, softness: 0.55 },
    // Named craters.
    { name: "Hall", kind: "crater", shape: "ellipse", lon: -145, lat: -80, semiMajorDeg: 13.9, semiMinorDeg: 13.9, tone: "darker", toneHex: 0x453f39, alpha: 0.6, softness: 0.5 },
    { name: "Roche", kind: "crater", shape: "ellipse", lon: 177, lat: 53, semiMajorDeg: 6.5, semiMinorDeg: 6.5, tone: "darker", toneHex: 0x453f39, alpha: 0.6, softness: 0.5 },
    { name: "Grildrig", kind: "crater", shape: "ellipse", lon: 165, lat: 82, semiMajorDeg: 6.7, semiMinorDeg: 6.7, tone: "darker", toneHex: 0x453f39, alpha: 0.55, softness: 0.5 },
    // Groove family: near-parallel crater-chains sweeping from near Stickney across
    // the leading hemisphere toward the trailing side.
    { name: "Groove 1", kind: "groove", shape: "polyline", polyline: [-95, 35, -55, 25, -10, 15, 40, 10, 90, 8], tone: "darker", toneHex: 0x433d37, alpha: 0.55, strokeWidthDeg: 1.4 },
    { name: "Groove 2", kind: "groove", shape: "polyline", polyline: [-100, 22, -55, 12, -8, 4, 42, 0, 92, -2], tone: "darker", toneHex: 0x433d37, alpha: 0.55, strokeWidthDeg: 1.4 },
    { name: "Groove 3", kind: "groove", shape: "polyline", polyline: [-98, 10, -52, 2, -6, -6, 44, -10, 94, -12], tone: "darker", toneHex: 0x433d37, alpha: 0.5, strokeWidthDeg: 1.3 },
    { name: "Groove 4", kind: "groove", shape: "polyline", polyline: [-92, -3, -48, -11, -4, -18, 46, -21, 96, -22], tone: "darker", toneHex: 0x433d37, alpha: 0.5, strokeWidthDeg: 1.3 },
    { name: "Groove 5", kind: "groove", shape: "polyline", polyline: [-85, 48, -45, 40, -5, 32, 45, 27, 95, 24], tone: "darker", toneHex: 0x433d37, alpha: 0.45, strokeWidthDeg: 1.2 },
    { name: "Groove 6", kind: "groove", shape: "polyline", polyline: [-88, -18, -44, -26, 0, -32, 50, -35, 100, -36], tone: "darker", toneHex: 0x433d37, alpha: 0.45, strokeWidthDeg: 1.2 },
  ],

  // ── Deimos ───────────────────────────────────────────────────────────────────
  // The outer moon: a thick regolith blanket buries its craters, so it reads far
  // smoother than Phobos — only two named craters (Swift, Voltaire), rendered as soft
  // shallow depressions rather than crisp bowls. Convention as Phobos.
  deimos: [
    { name: "Swift", kind: "crater", shape: "ellipse", lon: -1, lat: 12, semiMajorDeg: 13.9, semiMinorDeg: 13.9, tone: "slightly_darker", toneHex: 0x4c463e, alpha: 0.4, softness: 0.8 },
    { name: "Voltaire", kind: "crater", shape: "ellipse", lon: -18, lat: 22, semiMajorDeg: 13.9, semiMinorDeg: 13.9, tone: "slightly_darker", toneHex: 0x4c463e, alpha: 0.4, softness: 0.8 },
  ],
};
