/**
 * @lightlag/engine — public surface.
 *
 * The engine is a pure, deterministic, double-precision SI model of Solar-System
 * mechanics: no renderer, no DOM, no wall-clock, no game assumptions. A game is a
 * thin layer on top that supplies its own commands, goals, and views (see the
 * repository ARCHITECTURE.md).
 *
 * This barrel re-exports every module under a NAMESPACE, so there are never name
 * collisions and the call site reads as physics:
 *
 *     import { orbit, sim, vec3, constants } from "@lightlag/engine";
 *     const e = orbit.summarizeOrbit(...);
 *
 * If you prefer flat, tree-shakeable imports, reach a single module directly via
 * its subpath instead — both resolve to the same source:
 *
 *     import { summarizeOrbit } from "@lightlag/engine/orbit";
 *     import { add, cross } from "@lightlag/engine/math/vec3";
 *
 * The in-repo game uses the subpath form throughout.
 */

// ── Math primitives ─────────────────────────────────────────────────────────
export * as vec3 from "./math/vec3.ts";
export * as kepler from "./math/kepler.ts";
export * as integrators from "./math/integrators.ts";
export * as relativity from "./math/relativity.ts";

// ── Core simulation ─────────────────────────────────────────────────────────
export * as constants from "./constants.ts";
export * as ephemeris from "./ephemeris.ts";
export * as orbit from "./orbit.ts";
export * as perturbations from "./perturbations.ts";
export * as perturbed from "./perturbed.ts";
export * as propulsion from "./propulsion.ts";
export * as ships from "./ships.ts";
export * as refuel from "./refuel.ts";
export * as surface from "./surface.ts";
export * as forces from "./forces.ts";
export * as trajectory from "./trajectory.ts";
export * as route from "./route.ts";
export * as thermal from "./thermal.ts";
export * as stars from "./stars.ts";
export * as comms from "./comms.ts";
export * as serialize from "./serialize.ts";
export * as scenario from "./scenario.ts";
export * as time from "./time.ts";
export * as world from "./world.ts";
export * as sim from "./sim.ts";

// ── Maneuver solvers ────────────────────────────────────────────────────────
export * as lambert from "./maneuver/lambert.ts";
export * as hohmann from "./maneuver/hohmann.ts";
export * as porkchop from "./maneuver/porkchop.ts";
export * as biElliptic from "./maneuver/biElliptic.ts";
export * as arrival from "./maneuver/arrival.ts";
export * as approach from "./maneuver/approach.ts";
export * as flyby from "./maneuver/flyby.ts";
export * as assist from "./maneuver/assist.ts";
export * as moon from "./maneuver/moon.ts";
export * as moonTour from "./maneuver/moonTour.ts";
export * as suggest from "./maneuver/suggest.ts";
export * as criteria from "./maneuver/criteria.ts";
export * as lowThrust from "./maneuver/lowThrust.ts";
export * as entry from "./maneuver/entry.ts";
export * as guidance from "./maneuver/guidance.ts";
export * as interstellar from "./maneuver/interstellar.ts";
