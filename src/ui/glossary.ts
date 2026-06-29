/**
 * The term glossary — short, physics-true definitions for the vocabulary the HUD
 * throws at you (Δv, periapsis, prograde, aerocapture, proper time, …).
 *
 * The panels are dense with jargon that is exact, not decorative — and a player
 * who doesn't already know orbital mechanics has no way in. This module is the
 * single source of those definitions; {@link tooltip} surfaces them on hover, and
 * the shared DOM helpers ({@link dom} `kv`/`numberField`, {@link collapsible})
 * tag any label they recognise so the coverage comes for free.
 *
 * It is pure data + a normalising lookup — no DOM, so it stays a leaf module the
 * core never depends on and the UI can import anywhere.
 */

export interface TermDef {
  /** Canonical display name shown as the tooltip's heading. */
  title: string;
  /** One- or two-sentence definition. */
  def: string;
}

/** Authoring shape: one definition, reachable under any of several label aliases
 *  (the various ways the same concept is spelled across the panels). */
interface Entry {
  terms: string[];
  title?: string;
  def: string;
}

// Definitions, grouped the way the panels are. Aliases list every label the UI
// actually renders for the concept, so the lookup is an exact hit, not a guess.
const ENTRIES: Entry[] = [
  // ── Sections (the collapsible headers) ──────────────────────────────────────
  {
    terms: ["Designer"],
    def: "Build a rocket as a staged stack — set dry mass, propellant, Isp and thrust per stage and watch the Δv budget fall out of the rocket equation, live.",
  },
  {
    terms: ["Fleet"],
    def: "Every ship you've launched. Pick one to fly it; the badge counts how many are aloft.",
  },
  {
    terms: ["Flight"],
    def: "Live readout of the selected ship — its orbit, mass, remaining Δv, thermal/detection state, and any transfer or interstellar leg under way.",
  },
  {
    terms: ["Maneuver"],
    def: "Spend Δv in a chosen direction. The order travels to the ship at the speed of light, so it only takes effect after the one-way signal delay.",
  },
  {
    terms: ["Guidance"],
    def: "How a burn order is governed once it arrives. Open-loop fires the exact Δv you set, wherever the light-lag delay leaves the ship. Closed-loop carries a goal and the ship trims its own Δv at delivery to hit it, within a correction budget.",
  },
  {
    terms: ["Open-loop", "Open"],
    title: "Open-loop burn",
    def: "Fire the exact Δv you set, in the chosen direction, against whatever orbit the ship occupies when the order arrives — so it may land mis-sized. The cheap, predictable default: the light-lag bargain in its purest form.",
  },
  {
    terms: ["Closed-loop", "Closed"],
    title: "Closed-loop burn",
    def: "The order carries a goal (a target periapsis/apoapsis, or to circularize). At delivery the ship re-derives its Δv magnitude — spending no more than the correction budget you set — to meet the goal against its own live state, or refuses (NACK) if it can't.",
  },
  {
    terms: ["Circularize"],
    def: "A closed-loop goal: trim the orbit to a circle at the ship's radius when the order arrives. Refused (NACK) if the geometry can't reach a near-circular orbit within budget — e.g. burning away from an apsis.",
  },
  {
    terms: ["SURFACE OPS", "Surface ops"],
    def: "Landing and takeoff Δv budgeting for the body you're orbiting — descent, ascent, aerobraking, and entry heating.",
  },
  {
    terms: ["ELECTRIC SPIRAL"],
    title: "Electric spiral",
    def: "Commit a low-thrust electric transfer flown as a slow Edelbaum spiral between near-circular orbits — charged up front, not an impulsive burn.",
  },
  {
    terms: ["VIA FLYBY", "VIA FLYBY 2"],
    title: "Via flyby",
    def: "Pick a planet to swing past for a gravity assist on the way to the target — the slingshot bends the path for little or no fuel.",
  },
  {
    terms: ["OPTIMIZE FOR"],
    title: "Optimize for",
    def: "What the planner should minimise for the highlighted launch window — propellant (Δv), flight time, or a balance of the two.",
  },
  {
    terms: ["DESTINATION ORBIT", "CAPTURE MODE"],
    title: "Destination orbit",
    def: "Which orbit or point the mission ends at: a low circular orbit, a cheap loose ellipse, an aerocapture, a geostationary (synchronous) orbit, or one of the body's five Lagrange points.",
  },
  {
    terms: ["Geostationary (GEO)", "Synchronous"],
    title: "Geostationary / synchronous orbit",
    def: "A circular orbit whose period equals the body's rotation, so a satellite hangs over a fixed longitude (GEO ≈ 35,786 km altitude at Earth, areostationary at Mars). Reached by a Hohmann raise from your current orbit, or captured into directly on arrival; the equatorial plane change is included.",
  },
  {
    terms: ["Lagrange point", "L1", "L2", "L3", "L4", "L5"],
    title: "Lagrange point",
    def: "One of five points that co-orbit with a body where a craft can hold station against its parent's pull — Sun–Earth L2 hosts JWST. Reached by a transfer that ends in a small velocity match rather than a capture burn (there is no gravity well to brake into).",
  },
  {
    terms: ["Doppler"],
    title: "Doppler tint",
    def: "Tints each ship by the relativistic Doppler shift of its telemetry seen from the control node — red receding, blue approaching. Invisible at planetary speeds; deep red on a near-c torchship (it recedes the whole way out, strongest near mid-flight). Render-only; it changes nothing in the sim.",
  },

  // ── The rocket equation & the design ────────────────────────────────────────
  {
    terms: ["Δv", "Δv (m/s)", "Total Δv"],
    title: "Δv (delta-v)",
    def: "The change in velocity a ship can buy by burning propellant — the true currency of spaceflight. Every maneuver costs Δv. Δv = vₑ·ln(m₀/m_f).",
  },
  {
    terms: ["Δv remaining", "Ship Δv available"],
    title: "Δv remaining",
    def: "The delta-v still available from the propellant left aboard — what you have left to spend on burns, transfers and capture.",
  },
  {
    terms: ["Wet / final mass"],
    def: "Wet mass is the fully-fuelled stack; final mass is what's left once all propellant is spent. Their ratio sets the Δv.",
  },
  {
    terms: ["Mass"],
    def: "The ship's current total mass — dry structure plus remaining propellant plus payload.",
  },
  {
    terms: ["Initial T/W", "Liftoff thrust"],
    title: "Thrust-to-weight",
    def: "Thrust over weight at ignition. Below 1 the vehicle can't lift off a surface; in space any value still accelerates, just gently.",
  },
  {
    terms: ["Isp", "Isp s"],
    title: "Specific impulse (Isp)",
    def: "Engine efficiency, in seconds — more Δv per kilogram of propellant. Exhaust velocity vₑ = Isp·g₀; ~450 s for the best chemical engines, thousands for ion.",
  },
  {
    terms: ["Payload", "Payload (t)"],
    def: "The useful mass carried on top of the stack (tonnes) — everything that isn't engine, tank or propellant.",
  },
  {
    terms: ["dry t"],
    title: "Dry mass",
    def: "Dry mass of the stage (tonnes) — its structure and engines with the tanks empty.",
  },
  {
    terms: ["prop t"],
    title: "Propellant mass",
    def: "Propellant mass of the stage (tonnes) — the reaction mass it throws overboard to make thrust.",
  },
  {
    terms: ["kN"],
    title: "Thrust (kN)",
    def: "Stage thrust in kilonewtons — the force its engines produce.",
  },
  {
    terms: ["×N", "xN"],
    title: "Booster count",
    def: "Number of identical strap-on boosters that ignite with the stage, burn in parallel, and drop together when spent.",
  },
  {
    terms: ["LEO alt (km)"],
    title: "LEO altitude",
    def: "Altitude of the circular low-Earth parking orbit this design launches into (km).",
  },

  // ── Orbit geometry ──────────────────────────────────────────────────────────
  {
    terms: ["Periapsis alt", "Periapsis"],
    def: "Altitude of the lowest point of the orbit, above the body's surface — where the ship moves fastest.",
  },
  {
    terms: ["Apoapsis alt", "Apoapsis"],
    def: "Altitude of the highest point of the orbit — where the ship moves slowest. Reads 'escape' when the orbit is unbound.",
  },
  {
    terms: ["Period", "Orbital period"],
    def: "Time to complete one full orbit.",
  },
  {
    terms: ["Orbiting"],
    def: "The body the ship is gravitationally bound to right now — its primary.",
  },
  {
    terms: ["Frame"],
    title: "Reference frame",
    def: "Which frame the readout is measured in — 'heliocentric' once a ship leaves a planet and coasts in orbit about the Sun.",
  },
  {
    terms: ["Eccentricity"],
    def: "How elongated the orbit is: 0 is a perfect circle, near 1 a thin ellipse, and ≥1 is unbound (a hyperbolic escape).",
  },
  {
    terms: ["Inclination"],
    def: "Tilt of the orbit plane relative to the reference plane (the ecliptic, or a planet's equator), in degrees.",
  },
  {
    terms: ["Node precession"],
    def: "Rate at which the orbit plane slowly rotates because of the body's equatorial bulge (J2). Tuned just right it gives a sun-synchronous orbit.",
  },
  {
    terms: ["Apsidal precession"],
    def: "Rate at which the orbit's long axis (the periapsis direction) slowly rotates — again driven by J2 oblateness.",
  },
  {
    terms: ["Speed"],
    def: "Current speed relative to the body the ship orbits.",
  },
  {
    terms: ["Orbital speed"],
    def: "Speed of the body along its own orbit around the Sun.",
  },
  {
    terms: ["Distance from Sun"],
    def: "Heliocentric distance in astronomical units (1 AU = Earth's mean distance from the Sun, ~150 million km).",
  },

  // ── Light-lag (the thesis of the game) ──────────────────────────────────────
  {
    terms: ["Signal delay (1-way)", "Light-time from Earth", "One-way light-lag"],
    title: "Light-time (one-way)",
    def: "Time for light — and any command — to cross the distance, equal to distance ÷ c. You only ever see each object's past; orders arrive this much later, replies a round-trip after that.",
  },
  {
    terms: ["Order en route"],
    def: "A command you've already sent is still crawling out to the ship at the speed of light; this is the time until it arrives.",
  },

  // ── Thermal & detection (no stealth in space) ───────────────────────────────
  {
    terms: ["Solar flux"],
    def: "Sunlight power per square metre at this distance. It falls as 1/r², so ~1361 W/m² at Earth and far weaker the further out you go.",
  },
  {
    terms: ["Hull temp"],
    def: "Equilibrium hull temperature, set by absorbed sunlight and waste heat balanced against what the hull radiates away (P = εσAT⁴).",
  },
  {
    terms: ["IR signature"],
    def: "Infrared power the ship radiates — its thermal beacon. A firing drive blazes orders of magnitude brighter than a cold, coasting hull.",
  },
  {
    terms: ["Detectable to"],
    def: "Range at which a 5σ infrared detector could pick the ship out of the background noise. There is no real stealth in space.",
  },
  {
    terms: ["Min signal"],
    def: "Smallest signal power the modelled detector can register — its noise-equivalent power, here in attowatts (10⁻¹⁸ W).",
  },
  {
    terms: ["Drive waste heat"],
    def: "Heat the drive must dump while thrusting — the share of input power that doesn't end up as jet kinetic energy.",
  },
  {
    terms: ["Radiator needed"],
    def: "Radiator area required to shed that waste heat at the current hull temperature — power demands area, and area is signature.",
  },

  // ── Electric (low-thrust) propulsion ────────────────────────────────────────
  {
    terms: ["Drive power"],
    def: "Electrical power available to an electric (ion/Hall) drive. From solar panels it falls as 1/r² with distance from the Sun; from a reactor it's constant.",
  },
  {
    terms: ["Drive thrust"],
    def: "Actual thrust of the power-limited electric drive — min(rated, 2ηP/vₑ). Tiny (millinewtons) but it never stops, so it adds up over months.",
  },
  {
    terms: ["Spiraling", "Spiral"],
    title: "Electric spiral",
    def: "A low-thrust electric transfer flown as a gradual Edelbaum spiral between near-circular orbits, rather than one impulsive burn.",
  },

  // ── Maneuver directions ─────────────────────────────────────────────────────
  {
    terms: ["Prograde"],
    def: "Burn along the velocity vector. Raises the far side of the orbit (apoapsis) — the cheapest way to add orbital energy.",
  },
  {
    terms: ["Retrograde"],
    def: "Burn against the velocity vector. Lowers the far side of the orbit, shedding orbital energy — how you brake and drop into a lower orbit.",
  },
  {
    terms: ["Radial out"],
    def: "Burn straight away from the body. Rotates the orbit's apsides and shifts periapsis without changing its energy much.",
  },
  {
    terms: ["Radial in"],
    def: "Burn straight toward the body — the mirror of radial-out, nudging where periapsis sits.",
  },
  {
    terms: ["Normal"],
    def: "Burn perpendicular to the orbit plane, along the angular-momentum vector. Changes inclination, not orbit size.",
  },
  {
    terms: ["Anti-normal", "Antinormal"],
    def: "Burn opposite the orbit normal — the other way to tilt the orbital plane.",
  },

  // ── Transfers & captures ────────────────────────────────────────────────────
  {
    terms: ["Transfer"],
    def: "A planned interplanetary trajectory between two orbits, fired at a specific departure date dictated by where the planets are.",
  },
  {
    terms: ["Injection Δv"],
    def: "Delta-v of the departure burn that throws the ship off its parking orbit and onto the transfer trajectory.",
  },
  {
    terms: ["Capture Δv", "Arrival (capture) Δv", "Stage 1 capture Δv"],
    title: "Capture Δv",
    def: "Delta-v to brake from the arrival hyperbola into a bound orbit at the destination — often the most expensive burn of the mission.",
  },
  {
    terms: ["Depart"],
    def: "Date the departure burn fires.",
  },
  {
    terms: ["Arrive"],
    def: "Date the ship reaches the destination.",
  },
  {
    terms: ["Flight time"],
    def: "Duration of the transfer, from the departure burn to arrival.",
  },
  {
    terms: ["Optimizing"],
    def: "Which quantity the planner is minimising for the highlighted window — least Δv, shortest flight, or balanced.",
  },
  {
    terms: ["Aerobraking"],
    def: "Shedding speed for free in a pass through the atmosphere, cutting how much propulsive braking the engines must do.",
  },
  {
    terms: ["Aerocapture"],
    def: "A single deep pass through the atmosphere that brakes a hyperbolic arrival straight into orbit, saving nearly the whole capture burn.",
  },
  {
    terms: ["Capture orbit"],
    def: "The orbit you insert into — a low circle, or a loose ellipse with a high apoapsis that is far cheaper (Oberth) to enter.",
  },
  {
    terms: ["Saved vs circular"],
    def: "Delta-v saved by capturing into a loose ellipse instead of a low circular orbit.",
  },
  {
    terms: ["Saved vs propulsive"],
    def: "Delta-v saved by aerocapturing through the atmosphere instead of braking on the engines.",
  },
  {
    terms: ["Arrival trim Δv"],
    def: "The small burn after an aerocapture pass to tidy the orbit (typically raise periapsis back out of the atmosphere).",
  },
  {
    terms: ["Direct best Δv"],
    def: "Cheapest Δv for a direct transfer with no flyby, shown so you can weigh it against the gravity-assist route.",
  },
  {
    terms: ["Min-Δv flight time"],
    def: "Flight time of the absolute lowest-Δv window — shown when you've chosen to optimise for something other than fuel.",
  },
  {
    terms: ["flyby", "Flyby Δv", "Flyby Δv (total)"],
    title: "Gravity-assist flyby",
    def: "Swinging close past a planet to bend the trajectory and trade orbital energy with it — for little or no fuel. '(free)' means the bend needed no burn.",
  },
  {
    terms: ["Stage 2"],
    def: "The second leg of a cross-system moon mission — the parent-centric hop to the moon, which the sim auto-chains the instant the ship captures at the planet.",
  },
  {
    terms: ["best routes"],
    title: "Best routes",
    def: "Auto-searched candidate routes — direct and the workhorse gravity-assist chains — ranked under the chosen criterion.",
  },
  {
    terms: ["Direct"],
    def: "A straight transfer to the destination with no flybys.",
  },
  {
    terms: ["Suggest"],
    def: "Auto-search the best routes — direct and the workhorse gravity-assist chains (including VEEGA-style ones) — and rank them.",
  },
  {
    terms: ["1 flyby"],
    def: "Route the transfer via one gravity-assist flyby that you choose.",
  },
  {
    terms: ["2 flybys"],
    def: "Route the transfer via a two-flyby gravity-assist chain (e.g. Earth → Venus → Earth → Jupiter).",
  },

  // ── Surface ops & entry heating ─────────────────────────────────────────────
  {
    terms: ["Ascent Δv"],
    def: "Delta-v to climb from the surface to the chosen orbit, including gravity and drag losses.",
  },
  {
    terms: ["Descent Δv"],
    def: "Delta-v to drop from orbit to the surface, after any free aerobraking.",
  },
  {
    terms: ["gravity / drag loss"],
    def: "Δv wasted fighting gravity during the climb, plus Δv lost to atmospheric drag — not all thrust goes into orbital speed.",
  },
  {
    terms: ["Propellant", "Land propellant"],
    def: "Propellant mass this maneuver burns.",
  },
  {
    terms: ["Body"],
    def: "The body whose surface operations are being budgeted — and whether it has an atmosphere to brake against.",
  },
  {
    terms: ["Surface gravity"],
    def: "Gravitational acceleration at the body's surface, in m/s² (Earth ≈ 9.81).",
  },
  {
    terms: ["Escape velocity"],
    def: "Speed needed to break free of the body's gravity entirely, launched from its surface.",
  },
  {
    terms: ["Surface pressure"],
    def: "Atmospheric pressure at the surface, in atmospheres (Earth = 1 atm) or pascals where it's thin.",
  },
  {
    terms: ["Atmosphere"],
    def: "Whether the body has an atmosphere to brake and heat against — or is airless.",
  },
  {
    terms: ["Peak decel", "Decel"],
    def: "Peak deceleration during atmospheric entry, in g — cross-checked against the Allen-Eggers ballistic-entry solution.",
  },
  {
    terms: ["Peak heat flux", "Heat flux"],
    def: "Peak convective heating at the vehicle's nose (Sutton-Graves stagnation-point flux), in MW/m².",
  },
  {
    terms: ["Wall temp"],
    def: "Radiative-equilibrium temperature the heat-shield surface reaches during entry.",
  },
  {
    terms: ["Heat load"],
    def: "Total heat absorbed per unit area across the whole entry — the integral that sizes the heat shield (MJ/m²).",
  },
  {
    terms: ["Altitude"],
    def: "Height above the surface during the entry pass.",
  },

  // ── Ship state lines ────────────────────────────────────────────────────────
  {
    terms: ["Captured"],
    def: "The ship has braked into a bound orbit at its destination.",
  },
  {
    terms: ["Arrival"],
    def: "The ship has crossed into the destination's sphere of influence and is capturing.",
  },
  {
    terms: ["In transit"],
    def: "The ship is mid-transfer, coasting between departure and arrival.",
  },
  {
    terms: ["Surface"],
    def: "The ship is sitting on a body's surface, co-rotating with it.",
  },
  {
    terms: ["BURNING"],
    def: "An engine burn is under way; the figures show Δv delivered so far against the target.",
  },

  // ── Interstellar ────────────────────────────────────────────────────────────
  {
    terms: ["Interstellar"],
    def: "A leg to another star system, flown as a relativistic flip-and-burn: accelerate to the midpoint, flip, and decelerate the rest of the way.",
  },
  {
    terms: ["Drive"],
    def: "The torchship's drive — exhaust velocity (as a fraction of c) and proper acceleration (in g) it can sustain.",
  },
  {
    terms: ["Cruise speed"],
    def: "Peak speed the ship reaches, as a fraction of c, with the Lorentz factor γ at that speed.",
  },
  {
    terms: ["Crew clock (τ)", "Crew time (proper)"],
    title: "Proper time (crew clock)",
    def: "The years that pass for the crew. Near light-speed it runs slower than Earth's clock — time dilation, measured, not hand-waved.",
  },
  {
    terms: ["Earth time (coord.)"],
    title: "Coordinate time (Earth clock)",
    def: "The years that elapse back on Earth while the ship is under way — longer than the crew's own clock at relativistic speed.",
  },
  {
    terms: ["Mass ratio m₀/m_f", "Mass ratio"],
    def: "Start mass over dry mass. The rocket equation makes this grow ferociously with cruise speed — the tyranny of interstellar flight.",
  },
  {
    terms: ["Luminosity"],
    def: "Total radiant power the star pours out (the Sun: 3.828×10²⁶ W).",
  },
  {
    terms: ["Role"],
    def: "The body's role in the system — here, the central star everything else orbits.",
  },
];

/** Normalise a label for lookup: trim, collapse internal whitespace, lowercase.
 *  (Δ → δ, τ stays τ — both sides go through this, so it's consistent.) */
function norm(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

const TERMS = new Map<string, TermDef>();
for (const e of ENTRIES) {
  const def: TermDef = { title: e.title ?? e.terms[0]!, def: e.def };
  for (const alias of e.terms) {
    const key = norm(alias);
    // First writer wins — keeps an alias deliberately shared across entries stable.
    if (!TERMS.has(key)) TERMS.set(key, def);
  }
}

/** Prefix rules for labels that carry a dynamic tail (e.g. "Flyby Jupiter",
 *  "BEST ROUTES — least Δv"). Exact matches are tried first, so these only catch
 *  the runtime-built variants. */
const PREFIX_RULES: { prefix: string; key: string }[] = [
  { prefix: "flyby ", key: "flyby" },
  { prefix: "best routes", key: "best routes" },
];
const RESOLVED_PREFIXES: { prefix: string; def: TermDef }[] = PREFIX_RULES.flatMap((r) => {
  const def = TERMS.get(norm(r.key));
  return def ? [{ prefix: r.prefix, def }] : [];
});

/** Look up a definition for a UI label, or undefined if the term isn't known. */
export function defineTerm(label: string): TermDef | undefined {
  const key = norm(label);
  const exact = TERMS.get(key);
  if (exact) return exact;
  for (const { prefix, def } of RESOLVED_PREFIXES) if (key.startsWith(prefix)) return def;
  return undefined;
}

/** Whether a label has a glossary definition (cheap guard for the string builders). */
export function hasTerm(label: string): boolean {
  return defineTerm(label) !== undefined;
}

/** Escape a string for use inside a double-quoted HTML attribute value. */
export function escapeTermAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
