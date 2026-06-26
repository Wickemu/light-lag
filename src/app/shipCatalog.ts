/**
 * The preset fleet — a catalog of real and inferred spacecraft, each expressed
 * as an honest `ShipDesign` the player can load into the designer and fly.
 *
 * Ground rules (the project's one inviolable law applies to content too):
 *  - Every number is a published or carefully-inferred real figure. Stages are
 *    {dryMass, propMass, isp, thrust} in SI; Δv falls straight out of the same
 *    rocket equation the rest of the game runs on. No tuning "for balance".
 *  - The staged PRESETS here are classical: exhaust velocities far below c and
 *    total Δv well below it, run through the classical rocket equation. True
 *    relativistic torchships (Epstein, Daedalus, antimatter/photon) now live in
 *    INTERSTELLAR_CRAFT at the bottom — flyable on a flip-and-burn to the nearby
 *    stars via the relativistic-propulsion layer (the old PENDING_RELATIVISTIC
 *    list is kept as a record of what was waiting).
 *  - The sim places ships directly in LEO and never simulates ascent, so two
 *    kinds of preset coexist: full LAUNCH VEHICLES (rocket-equation showcases —
 *    their lower stages are gameplay-irrelevant once you're in orbit) and
 *    IN-SPACE craft (spacecraft, upper/kick stages, deep-space probes, nuclear
 *    and electric tugs) — the things you actually fly from LEO.
 *
 * Atmospheric first stages are listed at a representative sea-level-ish Isp and
 * upper/vacuum stages at vacuum Isp, so a launcher's total Δv reflects its real
 * total impulse rather than an all-vacuum overstatement. Electric craft now carry
 * a real power model (E() derives rated power from thrust): their thrust derates
 * as 1/r² for solar arrays, and a low-thrust transfer is planned via the Edelbaum
 * spiral (maneuver/lowThrust.ts) rather than flown as a weeks-long stepped burn.
 */

import { type ShipDesign } from "./commands.ts";
import { type Stage, exhaustVelocity } from "../core/propulsion.ts";
import { C } from "../core/constants.ts";

export type PresetCategory = "Historical" | "Current" | "Prototype" | "Sci-Fi";

/** Where, mechanically, the design lives. Drives a tag in the picker. */
export type PresetRole = "launcher" | "in-space";

export interface ShipPreset {
  id: string;
  /** Display name (mirrored into the loaded design's name). */
  name: string;
  category: PresetCategory;
  role: PresetRole;
  /** Short era/date string, e.g. "1967", "2018–", "ground-tested 1968". */
  era: string;
  /** One line: what it is, how it's modeled, and the gameplay/engine note. */
  blurb: string;
  design: ShipDesign;
}

// ── construction helpers (SI: kg, s, N) ──────────────────────────────────────
/** A stage from SI primitives. dry/prop in kg, isp in s, thrust in N. */
const S = (name: string, dryMass: number, propMass: number, isp: number, thrust: number): Stage => ({
  name,
  dryMass,
  propMass,
  isp,
  thrust,
});

/** An ELECTRIC (power-limited) stage. The rated electrical power is DERIVED from
 *  the rated thrust so the two stay consistent (P = F·vₑ/2η); `solar` (default
 *  true) makes the thrust derate as 1/r² with heliocentric distance. */
const E = (
  name: string, dryMass: number, propMass: number, isp: number, thrust: number,
  opts: { solar?: boolean; eta?: number } = {},
): Stage => {
  const eta = opts.eta ?? 0.6;
  return {
    name, dryMass, propMass, isp, thrust,
    electric: { powerW: (thrust * exhaustVelocity(isp)) / (2 * eta), eta, solar: opts.solar ?? true },
  };
};

interface DesignSpec {
  payloadMass: number; // kg
  altitudeKm?: number;
  inclinationDeg?: number;
  stages: Stage[];
}

const design = (name: string, spec: DesignSpec): ShipDesign => ({
  name,
  payloadMass: spec.payloadMass,
  altitudeKm: spec.altitudeKm ?? 400,
  inclinationDeg: spec.inclinationDeg ?? 28.5,
  stages: spec.stages,
});

// ════════════════════════════════════════════════════════════════════════════
// THE FLEET
// ════════════════════════════════════════════════════════════════════════════

export const SHIP_PRESETS: ShipPreset[] = [
  // ── HISTORICAL — launch vehicles (serial staging only; the engine cannot
  //    honestly model parallel strap-ons, so Shuttle/Soyuz/Ariane are absent) ──
  {
    id: "saturn-v",
    name: "Saturn V",
    category: "Historical",
    role: "launcher",
    era: "1967–1973",
    blurb:
      "The Apollo Moon rocket. Three serial stages pushing a ~45 t lunar payload; first stage shown at sea-level Isp. A pure rocket-equation showcase — you begin in LEO, so its boost stages don't fly in-game.",
    // Saturn V (Apollo Saturn V Flight Manual / NASA SP-4029). S-IVB doubles as
    // the trans-lunar injection stage.
    design: design("Saturn V", {
      payloadMass: 45_000, // Apollo CSM+LM+adapter to TLI
      altitudeKm: 185,
      inclinationDeg: 32.5,
      stages: [
        S("S-IC", 137_000, 2_149_500, 263, 35_100e3), // 5× F-1, SL Isp
        S("S-II", 40_100, 451_800, 421, 5_141e3), // 5× J-2, vac
        S("S-IVB", 13_500, 107_100, 421, 1_033e3), // 1× J-2, vac (TLI burn)
      ],
    }),
  },
  {
    id: "saturn-ib",
    name: "Saturn IB",
    category: "Historical",
    role: "launcher",
    era: "1966–1975",
    blurb:
      "Apollo's LEO workhorse (Apollo 7, Skylab crews, ASTP). S-IB booster + S-IVB upper stage; ~21 t to low orbit. Serial two-stage showcase.",
    // S-IB: 8× H-1. S-IVB-200 variant (NASA Saturn IB data).
    design: design("Saturn IB", {
      payloadMass: 21_000,
      altitudeKm: 185,
      stages: [
        S("S-IB", 41_600, 407_100, 289, 7_582e3), // 8× H-1, SL Isp
        S("S-IVB", 12_900, 104_300, 421, 1_000e3), // 1× J-2, vac
      ],
    }),
  },
  {
    id: "titan-ii-glv",
    name: "Titan II GLV",
    category: "Historical",
    role: "launcher",
    era: "1964–1966",
    blurb:
      "The Gemini launch vehicle: a two-stage hypergolic ICBM derivative carrying a 3.8 t capsule. Storable Aerozine-50/N₂O₄ — no cryogenics, instant ignition.",
    design: design("Titan II GLV", {
      payloadMass: 3_810,
      altitudeKm: 160,
      stages: [
        S("Stage 1", 6_736, 117_910, 296, 1_913e3), // LR-87, ~vac
        S("Stage 2", 2_719, 27_700, 316, 445e3), // LR-91, vac
      ],
    }),
  },

  // ── HISTORICAL — in-space craft & upper/kick stages (what you'd fly) ──
  {
    id: "apollo-csm",
    name: "Apollo CSM",
    category: "Historical",
    role: "in-space",
    era: "1968–1972",
    blurb:
      "The Command/Service Module. The Service Propulsion System (a single restartable hypergolic engine) gives the ~30 t stack ~2.8 km/s — enough for lunar-orbit insertion and the trans-Earth return. The SM is jettisoned (modeled as the stage) leaving the 5.6 t Command Module.",
    // Payload = Command Module; stage = Service Module (dropped before reentry).
    design: design("Apollo CSM", {
      payloadMass: 5_560,
      altitudeKm: 185,
      stages: [S("Service Module", 6_110, 18_410, 314, 91_200)],
    }),
  },
  {
    id: "apollo-lm",
    name: "Apollo Lunar Module",
    category: "Historical",
    role: "in-space",
    era: "1969–1972",
    blurb:
      "The lander, modeled as its true two-stage self: a throttleable descent stage (~2.5 km/s) dropped on the surface, then the ascent stage (~2.2 km/s). The ascent cabin is the surviving vehicle (the payload); the engine's dry structure rides with it, so its stage carries only propellant.",
    // The ascent stage is what survives to dock with the CSM, so its inert mass
    // (~2,150 kg incl. crew) is the payload; its engine is the propellant-only
    // stage above the jettisoned descent stage.
    design: design("Apollo Lunar Module", {
      payloadMass: 2_150,
      altitudeKm: 110, // representative lunar parking-orbit altitude
      stages: [
        S("Descent", 2_134, 8_200, 311, 45_040), // throttleable DPS, left on surface
        S("Ascent", 0, 2_365, 311, 15_600), // APS; inert mass is in the payload
      ],
    }),
  },
  {
    id: "s-ivb-tli",
    name: "S-IVB (TLI stage)",
    category: "Historical",
    role: "in-space",
    era: "1968–1972",
    blurb:
      "The Saturn third stage as flown from LEO: one restart of the J-2 to throw the ~49 t Apollo stack toward the Moon. A textbook demonstration of the Oberth effect — burn deep in Earth's well and the trans-lunar injection is cheap.",
    design: design("S-IVB (TLI stage)", {
      payloadMass: 48_600, // CSM + LM + spacecraft-LM adapter + instrument unit
      altitudeKm: 185,
      stages: [S("S-IVB", 13_500, 107_100, 421, 1_033e3)],
    }),
  },
  {
    id: "agena-d",
    name: "Agena-D",
    category: "Historical",
    role: "in-space",
    era: "1963–1987",
    blurb:
      "The first restartable upper stage and Gemini's docking target. Storable UDMH/IRFNA, multiple restarts — the prototype of the modern space tug.",
    design: design("Agena-D", {
      payloadMass: 1_000,
      stages: [S("Agena-D", 673, 6_170, 300, 71_200)],
    }),
  },
  {
    id: "centaur",
    name: "Centaur (RL10)",
    category: "Historical",
    role: "in-space",
    era: "1963–present",
    blurb:
      "The first LH₂/LOX stage and still the high-energy workhorse. Isp 450 s makes it a Δv powerhouse — ~6.5 km/s to a 4 t probe. Carried Surveyor, Viking, Voyager, Cassini, New Horizons on their way.",
    design: design("Centaur (RL10)", {
      payloadMass: 4_000,
      stages: [S("Centaur III", 2_247, 20_830, 450.5, 101_800)],
    }),
  },
  {
    id: "star-48b",
    name: "STAR 48B kick motor",
    category: "Historical",
    role: "in-space",
    era: "1982–present",
    blurb:
      "A spin-stabilized solid kick motor — here as New Horizons' third stage, the burn that made a 478 kg probe the fastest object ever to leave Earth. Solids can't throttle or restart: one fixed impulse, modeled as a single stage.",
    design: design("STAR 48B kick motor", {
      payloadMass: 478, // New Horizons
      altitudeKm: 185,
      stages: [S("STAR 48B", 124, 2_011, 286, 66_000)],
    }),
  },
  {
    id: "cassini",
    name: "Cassini",
    category: "Historical",
    role: "in-space",
    era: "1997–2017",
    blurb:
      "The Saturn orbiter's own bipropellant main engine (~2 km/s of MMH/N₂O₄). Modest Δv — interplanetary cruise was bought from its launcher and gravity assists, not its own tanks.",
    design: design("Cassini", {
      payloadMass: 2_125,
      stages: [S("Main engine", 400, 3_132, 308, 445)],
    }),
  },

  // ── CURRENT — launch vehicles (serial) ──
  {
    id: "falcon-9",
    name: "Falcon 9 Block 5",
    category: "Current",
    role: "launcher",
    era: "2018–present",
    blurb:
      "The workhorse of the 2020s. Two stages of RP-1/LOX; ~17 t to LEO with a recovered booster. First stage shown at a representative ascent Isp.",
    design: design("Falcon 9 Block 5", {
      payloadMass: 17_400,
      stages: [
        S("Stage 1", 25_600, 395_700, 300, 7_600e3), // 9× Merlin 1D
        S("Stage 2", 3_900, 92_670, 348, 981e3), // 1× Merlin Vac
      ],
    }),
  },
  {
    id: "electron",
    name: "Electron",
    category: "Current",
    role: "launcher",
    era: "2017–present",
    blurb:
      "Rocket Lab's small-sat launcher and the first orbital rocket with electric-pump-fed engines. ~300 kg to LEO from a two-stage carbon-composite airframe.",
    design: design("Electron", {
      payloadMass: 300,
      altitudeKm: 500,
      inclinationDeg: 45,
      stages: [
        S("Stage 1", 950, 9_250, 311, 162e3), // 9× Rutherford
        S("Stage 2", 250, 2_150, 343, 25_800), // 1× Rutherford Vac
      ],
    }),
  },
  {
    id: "vega",
    name: "Vega",
    category: "Current",
    role: "launcher",
    era: "2012–2024",
    blurb:
      "ESA's small launcher — genuinely serial (three solid stages stacked, then a liquid AVUM kick), which the engine models faithfully where strap-on rockets cannot. ~1.5 t to low orbit.",
    design: design("Vega", {
      payloadMass: 1_500,
      altitudeKm: 700,
      inclinationDeg: 90,
      stages: [
        S("P80", 7_330, 88_365, 280, 2_261e3),
        S("Zefiro 23", 1_840, 23_906, 287.5, 871e3),
        S("Zefiro 9", 835, 10_115, 296, 260e3),
        S("AVUM", 690, 577, 315.5, 2_420),
      ],
    }),
  },
  {
    id: "starship",
    name: "Starship + Super Heavy",
    category: "Current",
    role: "launcher",
    era: "2023–present (test)",
    blurb:
      "The fully-reusable methalox heavy-lifter. Two serial stages, ~100 t to LEO. NOTE: dry masses are public targets, not flight-proven — treat its numbers as provisional.",
    design: design("Starship + Super Heavy", {
      payloadMass: 100_000,
      stages: [
        S("Super Heavy", 200_000, 3_400_000, 330, 74_400e3), // 33× Raptor, SL
        S("Starship", 120_000, 1_200_000, 363, 12_200e3), // 6× Raptor, vac
      ],
    }),
  },

  // ── CURRENT — in-space stages & craft ──
  {
    id: "fregat",
    name: "Fregat",
    category: "Current",
    role: "in-space",
    era: "2000–present",
    blurb:
      "Soyuz's restartable storable upper stage; flies the high-orbit and interplanetary legs (Mars Express, ExoMars). ~3.4 km/s to a 2 t payload.",
    design: design("Fregat", {
      payloadMass: 2_000,
      stages: [S("Fregat", 980, 5_350, 333.2, 19_850)],
    }),
  },
  {
    id: "briz-m",
    name: "Briz-M",
    category: "Current",
    role: "in-space",
    era: "1999–present",
    blurb:
      "Proton's storable upper stage, with a jettisonable toroidal tank. The geostationary-transfer hauler of the Russian fleet — ~4.9 km/s to a 3 t payload.",
    design: design("Briz-M", {
      payloadMass: 3_000,
      stages: [S("Briz-M", 2_370, 19_800, 326, 19_600)],
    }),
  },
  {
    id: "orion-esm",
    name: "Orion (ESM)",
    category: "Current",
    role: "in-space",
    era: "2022–present",
    blurb:
      "NASA's lunar crew vehicle with the European Service Module. A repurposed Shuttle OMS engine (AJ10) gives the ~25 t stack a deliberately modest ~1.3 km/s.",
    design: design("Orion (ESM)", {
      payloadMass: 10_400, // crew module
      altitudeKm: 185,
      stages: [S("Service Module", 6_185, 8_600, 316, 25_700)],
    }),
  },
  {
    id: "dawn",
    name: "Dawn (ion)",
    category: "Current",
    role: "in-space",
    era: "2007–2018",
    blurb:
      "The ion-drive record holder: an NSTAR gridded thruster (Isp 3100 s) that gave a 1.2 t probe more Δv than any spacecraft before it — Vesta AND Ceres on one tank. Thrust is 92 mN, so a manual burn here would take months; plan transfers instead.",
    design: design("Dawn (ion)", {
      payloadMass: 702,
      stages: [E("NSTAR ion", 45, 425, 3_100, 0.092)], // 425 kg xenon
    }),
  },
  {
    id: "dart",
    name: "DART (NEXT-C ion)",
    category: "Current",
    role: "in-space",
    era: "2021–2022",
    blurb:
      "The asteroid-deflection demonstrator, flying NASA's next-gen NEXT-C gridded ion engine (Isp 4190 s, 236 mN). Low thrust, high efficiency — same plan-don't-burn caveat as all electric craft.",
    design: design("DART (NEXT-C ion)", {
      payloadMass: 460,
      stages: [E("NEXT-C ion", 30, 60, 4_190, 0.236)], // ~60 kg xenon
    }),
  },
  {
    id: "smart-1",
    name: "SMART-1 (Hall)",
    category: "Current",
    role: "in-space",
    era: "2003–2006",
    blurb:
      "ESA's tech demo that spiraled from GTO to lunar orbit on a single PPS-1350 Hall thruster (Isp 1640 s, 68 mN) over 13 months — ~3.9 km/s on 82 kg of xenon.",
    design: design("SMART-1 (Hall)", {
      payloadMass: 250,
      altitudeKm: 700,
      stages: [E("PPS-1350 Hall", 35, 82, 1_640, 0.068)],
    }),
  },
  {
    id: "gateway-ppe",
    name: "Gateway PPE (AEPS)",
    category: "Current",
    role: "in-space",
    era: "2027– (planned)",
    blurb:
      "The lunar Gateway's Power and Propulsion Element: 50 kW-class AEPS Hall thrusters (Isp 2600 s). A solar-electric tug — high Δv, gentle thrust — meant to haul modules between Earth and lunar orbits.",
    design: design("Gateway PPE (AEPS)", {
      payloadMass: 5_000,
      stages: [E("AEPS Hall ×3", 4_000, 2_500, 2_600, 0.6)],
    }),
  },
  {
    id: "block-dm",
    name: "Block DM",
    category: "Current",
    role: "in-space",
    era: "1974–present",
    blurb:
      "A long-lived LOX/kerosene upper stage (Proton, Zenit/Sea Launch). Restartable, ~4.2 km/s to a 3 t payload — a rare cryogenic-grade Isp on a storable-style workhorse.",
    design: design("Block DM", {
      payloadMass: 3_000,
      stages: [S("Block DM", 3_500, 15_000, 361, 85_000)],
    }),
  },

  // ── PROTOTYPE — built & tested, or detailed design studies ──
  {
    id: "nerva",
    name: "NERVA (NTR)",
    category: "Prototype",
    role: "in-space",
    era: "ground-tested 1964–1969",
    blurb:
      "A solid-core nuclear-thermal rocket: hydrogen heated by a fission reactor to Isp ~850 s — twice any chemical engine, at chemical-class thrust. Repeatedly ground-fired (NRX, XE-Prime); flight-ready in 1969, then cancelled. Bulky LH₂ tankage keeps the dry mass high.",
    design: design("NERVA (NTR)", {
      payloadMass: 20_000,
      stages: [S("NERVA NTR", 12_000, 40_000, 850, 246_000)],
    }),
  },
  {
    id: "phoebus-2a",
    name: "Phoebus-2A (NTR)",
    category: "Prototype",
    role: "in-space",
    era: "ground-tested 1968",
    blurb:
      "The most powerful nuclear-thermal rocket ever fired: ~4 GW, 930 kN at Isp ~820 s on the test stand at Jackass Flats. A heavy-lift NTR stage, never flown.",
    design: design("Phoebus-2A (NTR)", {
      payloadMass: 40_000,
      stages: [S("Phoebus-2A", 18_000, 80_000, 820, 930_000)],
    }),
  },
  {
    id: "vasimr",
    name: "VASIMR (VX-200)",
    category: "Prototype",
    role: "in-space",
    era: "tested 2009–present",
    blurb:
      "An RF plasma rocket (Ad Astra's VX-200) tested at 200 kW: Isp ~5000 s at 5.7 N. Variable-specific-impulse in principle; modeled here at a fixed high-Isp point. Milli-g thrust — superb for planned transfers, impractical for a manual burn.",
    design: design("VASIMR (VX-200)", {
      payloadMass: 2_000,
      stages: [E("VX-200 plasma", 1_000, 1_000, 5_000, 5.7, { solar: false })],
    }),
  },
  {
    id: "orion-pulse",
    name: "Project Orion (10 m)",
    category: "Prototype",
    role: "in-space",
    era: "design study 1958–1965",
    blurb:
      "Nuclear-pulse propulsion: ride a pusher-plate on a string of atomic bombs. The 10 m interplanetary reference design pairs Isp ~3000 s with thrust no other high-Isp drive can touch — high Δv AND high T/W. Modeled as a continuous time-average of the pulses.",
    design: design("Project Orion (10 m)", {
      payloadMass: 200_000,
      stages: [S("Pulse unit magazine", 500_000, 1_000_000, 3_000, 14_700e3)],
    }),
  },
  {
    id: "gas-core-ntr",
    name: "Gas-core NTR (open)",
    category: "Prototype",
    role: "in-space",
    era: "design study 1960s–1970s",
    blurb:
      "An open-cycle gas-core nuclear rocket — fissioning uranium plasma heats hydrogen to Isp ~3500 s while still delivering meganewton thrust. The high-water mark of nuclear-thermal paper studies; never built (it exhausts fissile fuel overboard).",
    design: design("Gas-core NTR (open)", {
      payloadMass: 50_000,
      stages: [S("Gas-core reactor", 30_000, 200_000, 3_500, 3_500e3)],
    }),
  },
  {
    id: "nep-tug",
    name: "Nuclear-electric tug",
    category: "Prototype",
    role: "in-space",
    era: "design study",
    blurb:
      "A reactor-powered ion tug (Isp ~6000 s): a fission reactor and big radiators feeding electric thrusters, unbound by the 1/r² solar fall-off that limits solar-electric craft in the outer system. Very low thrust — a planned-transfer vehicle.",
    design: design("Nuclear-electric tug", {
      payloadMass: 10_000,
      stages: [S("Reactor + ion drive", 8_000, 6_000, 6_000, 1.0)],
    }),
  },

  // ── SCI-FI — fictional craft with inferred, sub-relativistic parameters.
  //    (Relativistic torchships are held back; see PENDING_RELATIVISTIC.) ──
  {
    id: "hermes",
    name: "Hermes (The Martian)",
    category: "Sci-Fi",
    role: "in-space",
    era: "fiction (2035)",
    blurb:
      "The Ares cycler from The Martian: a cluster of VASIMR ion engines holding a constant ~2 mm/s². Parameters inferred from the novel's stated acceleration and a VASIMR-class Isp (~5000 s) — gentle, efficient, and entirely sub-relativistic.",
    design: design("Hermes (The Martian)", {
      payloadMass: 60_000,
      stages: [S("VASIMR cluster", 30_000, 40_000, 5_000, 200)],
    }),
  },
  {
    id: "discovery-one",
    name: "Discovery One (2001)",
    category: "Sci-Fi",
    role: "in-space",
    era: "fiction (2001)",
    blurb:
      "The Jupiter ship of 2001: A Space Odyssey. Canon is deliberately vague (Clarke described a low-thrust nuclear drive), so these are inferred figures for a nuclear-electric craft — a plausible, honest reading rather than a specified one.",
    design: design("Discovery One (2001)", {
      payloadMass: 30_000,
      stages: [S("Nuclear-electric drive", 20_000, 30_000, 4_000, 1_000)],
    }),
  },
];

export const PRESETS_BY_ID: Map<string, ShipPreset> = new Map(SHIP_PRESETS.map((p) => [p.id, p]));

export const PRESET_CATEGORIES: PresetCategory[] = ["Historical", "Current", "Prototype", "Sci-Fi"];

/** Presets grouped by category, in catalog order — for a grouped picker. */
export function presetsByCategory(): { category: PresetCategory; presets: ShipPreset[] }[] {
  return PRESET_CATEGORIES.map((category) => ({
    category,
    presets: SHIP_PRESETS.filter((p) => p.category === category),
  })).filter((g) => g.presets.length > 0);
}

/**
 * A fresh, deeply-copied ShipDesign from a preset — safe to hand to the live
 * editor without aliasing the catalog (stages are mutated in place by the UI).
 */
export function presetToDesign(preset: ShipPreset): ShipDesign {
  const d = preset.design;
  return {
    name: d.name,
    payloadMass: d.payloadMass,
    altitudeKm: d.altitudeKm,
    inclinationDeg: d.inclinationDeg,
    // Deep-copy stages AND their boosters so editing the loaded design never
    // mutates the shared catalog entry.
    stages: d.stages.map((s) => ({ ...s, boosters: s.boosters?.map((b) => ({ ...b })) })),
  };
}

/**
 * Marquee craft that the CURRENT classical engine cannot represent honestly:
 * their real performance is relativistic (exhaust velocity a large fraction of
 * c, and/or mission Δv approaching c), so a classical Tsiolkovsky figure would
 * be a lie. They are parked here, ready to add as presets once the relativistic
 * propulsion layer (relativistic rocket equation + continuous high-thrust
 * integration) is in place. Keep the data; don't expose it as flyable yet.
 */
export const PENDING_RELATIVISTIC: { name: string; note: string }[] = [
  {
    name: "Epstein Drive (The Expanse)",
    note: "Fusion torch sustaining multiple g for days/weeks; implied Δv and exhaust velocity are a large fraction of c. The defining relativistic torchship.",
  },
  {
    name: "Project Daedalus (cruise)",
    note: "Inertial-confinement fusion; design cruise 0.12 c. The boost itself needs a relativistic rocket equation — classical Tsiolkovsky badly mispredicts it.",
  },
  {
    name: "Project Orion (battleship / interstellar)",
    note: "The large nuclear-pulse variants targeting ~0.03–0.1 c. The interplanetary 10 m version IS included above; the high-c variants wait.",
  },
  {
    name: "Bussard ramjet / antimatter & photon rockets",
    note: "Exhaust velocity at or near c by definition — meaningless without the relativistic layer.",
  },
  {
    name: "Rocinante (The Expanse)",
    note: "Epstein-drive frigate; same relativistic torch regime as the Epstein entry.",
  },
];

/**
 * Relativistic torchships — now flyable, with the relativistic-propulsion layer
 * in place (propulsion.ts: rapidity rocket equation + constant-proper-accel
 * brachistochrone). Each is a constant-PROPER-acceleration craft the interstellar
 * planner can dispatch on a flip-and-burn to a nearby star. `exhaustVelocity` is
 * a fraction of c; `properAccel` is the sustained acceleration. The mass ratios
 * these imply are real and often brutal — that honesty is the point.
 */
export interface InterstellarCraft {
  name: string;
  exhaustVelocity: number; // m/s (≤ c)
  properAccel: number; // m/s² (sustained)
  note: string;
}

export const INTERSTELLAR_CRAFT: InterstellarCraft[] = [
  {
    name: "Photon rocket (1g)",
    exhaustVelocity: C, properAccel: 9.80665,
    note: "Exhaust velocity = c by definition — the ideal limit. 1g flip-and-burn reaches the nearest stars in a few years of crew time; the mass ratio is the lowest physics allows for a given Δv.",
  },
  {
    name: "Antimatter rocket (1g)",
    exhaustVelocity: 0.33 * C, properAccel: 9.80665,
    note: "Matter–antimatter annihilation, ~⅓ c effective exhaust after losses. Sustains 1g; the defining high-performance interstellar drive short of a photon rocket.",
  },
  {
    name: "Epstein drive (The Expanse)",
    exhaustVelocity: 0.12 * C, properAccel: 9.80665,
    note: "Fusion torch sustaining ~1g (and far more in-universe). A high exhaust velocity, but well below c — interstellar trips imply a steep mass ratio.",
  },
  {
    name: "Project Daedalus boost (½g)",
    exhaustVelocity: 0.036 * C, properAccel: 4.9,
    note: "Inertial-confinement fusion, ~10,000 km/s exhaust. The real Daedalus was a one-way 0.12c flyby; sustaining even ½g to brake at the target needs a mass ratio it never carried — the planner shows why.",
  },
  {
    name: "Orion (interstellar, 0.03g)",
    exhaustVelocity: 0.05 * C, properAccel: 0.3,
    note: "Nuclear-pulse, the high-c battleship variant. Gentle sustained acceleration; the classic 'how much does a real fusion/fission drive actually buy you' reference.",
  },
];
