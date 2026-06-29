/**
 * Auto-route suggestion — "plan the trip for me". Given an origin and a destination,
 * search a small curated set of routes (a direct transfer, the workhorse single-flyby
 * gravity assists, and a few VEEGA-style two-flyby chains) and rank them by the player's
 * criterion (least Δv / shortest time / balanced).
 *
 * Everything here is a bounded, fixed-count search reusing the existing porkchop and
 * assist/chain solvers, so a "Suggest" click is deterministic and cheap. The same
 * window-sizing and 8-departure-sample sweeps the transfer panel already used are
 * factored here so the panel and the suggester share one implementation.
 */

import { computePorkchop, type Porkchop, type PorkCell } from "./porkchop.ts";
import { searchAssist, searchChain, type AssistResult, type ChainAssistResult } from "./assist.ts";
import { hohmann, synodicPeriod } from "./hohmann.ts";
import { orbitalPeriod } from "../orbit.ts";
import { bodyElements } from "../ephemeris.ts";
import { BODY_BY_ID, MU_SUN, DAY } from "../constants.ts";
import { better, score, type Criterion, type ScoreRefs, type Scorable } from "./criteria.ts";

/** The heliocentric departure-date and time-of-flight window to search for a leg —
 *  synodic-scaled so distant targets get a usable span. Shared by the panel porkchop
 *  and the suggester. */
export interface TransferWindow {
  depSpan: number; // s — how far ahead to scan for a departure
  tofMin: number; // s
  tofMax: number; // s
}
export function transferWindow(fromId: string, toId: string, t0: number): TransferWindow {
  const from = BODY_BY_ID.get(fromId)!, to = BODY_BY_ID.get(toId)!;
  const aFrom = bodyElements(from, t0)?.a ?? from.radius;
  const aTo = bodyElements(to, t0)?.a ?? aFrom;
  const hTof = hohmann(MU_SUN, aFrom, aTo).tof;
  const synodic = synodicPeriod(orbitalPeriod(aFrom, MU_SUN), orbitalPeriod(aTo, MU_SUN));
  return {
    depSpan: Math.min(Math.max(1.3 * synodic, 500 * DAY), 8000 * DAY),
    tofMin: Math.max(20 * DAY, 0.3 * hTof),
    tofMax: 1.9 * hTof,
  };
}

export interface SweepParams {
  rParkFrom: number;
  rParkTo: number;
  depSpan: number;
  criterion?: Criterion;
  refs?: ScoreRefs;
}

/** Best single-flyby assist across 8 departure samples spanning `depSpan` (the sweep
 *  the transfer panel runs), ranked by criterion. null if none feasible. */
export function bestAssist(
  fromId: string, viaId: string, targetId: string, t0: number, p: SweepParams,
): AssistResult | null {
  if (viaId === fromId || viaId === targetId) return null;
  const t0From = bodyElements(BODY_BY_ID.get(fromId)!, t0)?.a ?? BODY_BY_ID.get(fromId)!.radius;
  const aFly = bodyElements(BODY_BY_ID.get(viaId)!, t0)?.a ?? t0From;
  const aTo = bodyElements(BODY_BY_ID.get(targetId)!, t0)?.a ?? t0From;
  const tofToFly = hohmann(MU_SUN, t0From, aFly).tof;
  const tofFlyToTgt = hohmann(MU_SUN, aFly, aTo).tof;
  const crit = p.criterion ?? "dv";
  const refs = p.refs ?? { dvRef: 1, tofRef: 1 };
  const sc = (r: AssistResult): Scorable => ({ dvTotal: r.dvTotal, tof: r.tArrive - r.tDepart });
  let best: AssistResult | null = null;
  for (let k = 0; k < 8; k++) {
    const tDep = t0 + (p.depSpan * k) / 7;
    const r = searchAssist(fromId, viaId, targetId, {
      tDepart: tDep,
      flybyWindow: [tDep + 0.6 * tofToFly, tDep + 1.6 * tofToFly],
      arriveWindow: [tDep + 0.6 * tofToFly + 0.5 * tofFlyToTgt, tDep + 1.6 * tofToFly + 2.2 * tofFlyToTgt],
      rParkFrom: p.rParkFrom, rParkTo: p.rParkTo, steps: 12, criterion: crit, refs,
    });
    if (r && (!best || better(sc(r), sc(best), crit, refs))) best = r;
  }
  return best;
}

/** Best multi-flyby chain across 8 departure samples, ranked by criterion. */
export function bestChain(
  bodyIds: string[], t0: number, p: SweepParams,
): { result: ChainAssistResult; times: number[] } | null {
  const crit = p.criterion ?? "dv";
  const refs = p.refs ?? { dvRef: 1, tofRef: 1 };
  const sc = (r: ChainAssistResult): Scorable => ({ dvTotal: r.dvTotal, tof: r.tArrive - r.tDepart });
  let best: { result: ChainAssistResult; times: number[] } | null = null;
  for (let k = 0; k < 8; k++) {
    const tDep = t0 + (p.depSpan * k) / 7;
    const r = searchChain(bodyIds, { tDepart: tDep, rParkFrom: p.rParkFrom, rParkTo: p.rParkTo, steps: 6, criterion: crit, refs });
    if (r && (!best || better(sc(r.result), sc(best.result), crit, refs))) best = r;
  }
  return best;
}

/** The criterion-winning porkchop cell (two-pass: min-Δv for refs, then min-score). */
export function bestPorkCell(pork: Porkchop, crit: Criterion): PorkCell | null {
  let dvMin: PorkCell | null = null;
  for (const col of pork.cells) for (const c of col) if (isFinite(c.total) && (!dvMin || c.total < dvMin.total)) dvMin = c;
  if (!dvMin || crit === "dv") return dvMin;
  const refs = { dvRef: dvMin.total, tofRef: dvMin.tof };
  let win: PorkCell | null = null;
  for (const col of pork.cells) for (const c of col) {
    if (!isFinite(c.total)) continue;
    if (!win || better({ dvTotal: c.total, tof: c.tof }, { dvTotal: win.total, tof: win.tof }, crit, refs)) win = c;
  }
  return win;
}

// ── Suggestion ───────────────────────────────────────────────────────────────

/** The workhorse gravity bodies, and a few VEEGA-style two-flyby patterns. */
const FLYBY_POOL = ["venus", "earth", "mars", "jupiter"];
const TWO_FLYBY_PATTERNS = [["venus", "earth"], ["earth", "earth"], ["venus", "venus"]];

export interface SuggestedRoute {
  kind: "direct" | "assist" | "chain";
  label: string;
  bodyIds: string[]; // [origin, ...vias, target]
  dvTotal: number;
  tof: number;
  tDepart: number;
  tArrive: number;
  assist?: AssistResult;
  chain?: { result: ChainAssistResult; times: number[] };
  cell?: { depT: number; arrT: number };
}

export interface SuggestBudget {
  rParkFrom: number;
  rParkTo: number;
}

/**
 * Suggest and rank a handful of routes from `originId` to `targetId`. Always includes
 * the direct transfer; adds curated single-flyby and (for outer targets) two-flyby
 * routes whose flyby bodies sit usefully along the leg. Each route is solved at its own
 * cheapest window, then all are ranked by `crit`. Deterministic and bounded (≤ ~8
 * searches). Returns the top 3 plus the direct route (deduped).
 */
export function suggestRoutes(
  originId: string, targetId: string, t0: number, budget: SuggestBudget, crit: Criterion,
): SuggestedRoute[] {
  const win = transferWindow(originId, targetId, t0);
  const sweep: SweepParams = { rParkFrom: budget.rParkFrom, rParkTo: budget.rParkTo, depSpan: win.depSpan };
  // Each candidate is solved at its cheapest window (dv); routes are ranked by `crit`
  // afterward with a shared reference scale, so "balanced" is self-consistent.
  const searchCrit: Criterion = "dv";
  const aFrom = bodyElements(BODY_BY_ID.get(originId)!, t0)?.a ?? 1;
  const aTo = bodyElements(BODY_BY_ID.get(targetId)!, t0)?.a ?? aFrom;
  const aJup = bodyElements(BODY_BY_ID.get("jupiter")!, t0)?.a ?? 7.78e11;

  const routes: SuggestedRoute[] = [];

  // 1. Direct.
  const pork = computePorkchop({
    fromId: originId, toId: targetId, depStart: t0, depEnd: t0 + win.depSpan, depN: 48,
    tofMin: win.tofMin, tofMax: win.tofMax, tofN: 36, rParkFrom: budget.rParkFrom, rParkTo: budget.rParkTo,
  });
  const cell = bestPorkCell(pork, "dv");
  if (cell) {
    routes.push({
      kind: "direct", label: "Direct", bodyIds: [originId, targetId],
      dvTotal: cell.total, tof: cell.tof, tDepart: cell.depT, tArrive: cell.arrT,
      cell: { depT: cell.depT, arrT: cell.arrT },
    });
  }

  // 2. Single-flyby candidates: a useful-mass body whose orbit lies along the leg.
  for (const f of FLYBY_POOL) {
    if (f === originId || f === targetId) continue;
    const aF = bodyElements(BODY_BY_ID.get(f)!, t0)?.a ?? 0;
    const lo = Math.min(aFrom, aTo) * 0.5, hi = Math.max(aFrom, aTo) * 2.5;
    if (aF < lo || aF > hi) continue;
    const r = bestAssist(originId, f, targetId, t0, { ...sweep, criterion: searchCrit });
    if (r) {
      routes.push({
        kind: "assist", label: `${BODY_BY_ID.get(f)!.name} flyby`, bodyIds: [originId, f, targetId],
        dvTotal: r.dvTotal, tof: r.tArrive - r.tDepart, tDepart: r.tDepart, tArrive: r.tArrive, assist: r,
      });
    }
  }

  // 3. Two-flyby chains — only worth it for outer (Jupiter-class+) targets.
  if (aTo > aJup * 0.5) {
    for (const [g, h] of TWO_FLYBY_PATTERNS) {
      const ids = [originId, g!, h!, targetId];
      if (new Set(ids).size < ids.length) continue; // collapse adjacent dupes
      const r = bestChain(ids, t0, { ...sweep, criterion: searchCrit });
      if (r) {
        routes.push({
          kind: "chain", label: `${BODY_BY_ID.get(g!)!.name} → ${BODY_BY_ID.get(h!)!.name}`,
          bodyIds: ids, dvTotal: r.result.dvTotal, tof: r.result.tArrive - r.result.tDepart,
          tDepart: r.result.tDepart, tArrive: r.result.tArrive, chain: r,
        });
      }
    }
  }

  if (routes.length === 0) return [];

  // Rank by the chosen criterion with a shared reference (the cheapest route).
  const cheapest = routes.reduce((m, r) => (r.dvTotal < m.dvTotal ? r : m));
  const refs: ScoreRefs = { dvRef: cheapest.dvTotal, tofRef: cheapest.tof };
  const sorted = [...routes].sort((a, b) => score(a, crit, refs) - score(b, crit, refs)
    || a.dvTotal - b.dvTotal || a.tof - b.tof);

  // Top 3, plus always the direct route for comparison (deduped).
  const top = sorted.slice(0, 3);
  const direct = routes.find((r) => r.kind === "direct");
  if (direct && !top.includes(direct)) top.push(direct);
  return top;
}
