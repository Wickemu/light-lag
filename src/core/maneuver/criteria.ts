/**
 * Trajectory-selection criteria — how the planner ranks candidate transfers when the
 * player asks to optimize for least propellant, shortest flight, or a balance.
 *
 * A pure scoring layer over anything that exposes a Δv and a time-of-flight: the
 * porkchop cells, single-flyby assists, and multi-flyby chains all become `Scorable`,
 * so one comparator drives every "pick the best" in the UI. The ordering is a strict
 * total order (score, then Δv, then tof), so the winner never depends on grid
 * traversal order — the same determinism guarantee the rest of the core keeps.
 *
 * SI throughout: Δv in m/s, tof in s.
 */

export type Criterion = "dv" | "time" | "balanced";

/** Anything rankable: a total Δv cost and a flight time. */
export interface Scorable {
  dvTotal: number; // m/s
  tof: number; // s
}

/**
 * Reference scales that make "balanced" dimensionless. `dvRef`/`tofRef` are usually
 * the cheapest-Δv candidate's own Δv and flight time, so a balanced score reads as
 * "how much Δv (in cheap-route units) I'd trade to go faster than the cheapest route".
 * `k` weights time against Δv (1 ⇒ equal weight at the reference).
 */
export interface ScoreRefs {
  dvRef: number;
  tofRef: number;
  k?: number;
}

/** Default time weight for the balanced criterion (equal weight at the reference). */
export const BALANCED_TIME_WEIGHT = 1;

/** The score of a candidate under a criterion — lower is better. */
export function score(c: Scorable, crit: Criterion, refs: ScoreRefs): number {
  switch (crit) {
    case "dv":
      return c.dvTotal;
    case "time":
      return c.tof;
    case "balanced": {
      const k = refs.k ?? BALANCED_TIME_WEIGHT;
      return c.dvTotal / Math.max(refs.dvRef, 1) + k * (c.tof / Math.max(refs.tofRef, 1));
    }
  }
}

/**
 * True if `a` is a strictly better candidate than `b` under `crit`. A total ordering
 * tie-broken on (score, then Δv, then tof), so the chosen winner is independent of the
 * order candidates are visited in — usable directly as the `<` test inside a grid search.
 */
export function better(a: Scorable, b: Scorable, crit: Criterion, refs: ScoreRefs): boolean {
  const sa = score(a, crit, refs), sb = score(b, crit, refs);
  if (sa !== sb) return sa < sb;
  if (a.dvTotal !== b.dvTotal) return a.dvTotal < b.dvTotal;
  return a.tof < b.tof;
}
