/**
 * Two-impulse circular orbit raise/lower within a single body's SOI — the intra-system move a
 * LEO→GEO (geostationary positioning) mission flies. A Hohmann transfer between the circular
 * radii, with any plane change folded into the burn at the HIGHER radius (where orbital speed is
 * lowest, so rotating the velocity is cheapest). For an equatorial GEO arrival from an inclined
 * parking orbit, that fold makes the plane change nearly free relative to a separate burn.
 *
 * SI throughout. `mu` = GM of the body both orbits are about.
 */

import { hohmann } from "./hohmann.ts";
import { visVivaSpeed, circularSpeed, combinedPlaneChangeDv } from "../orbit.ts";

export interface OrbitRaise {
  dv1: number; // first burn (m/s) — at r1
  dv2: number; // second burn (m/s) — at r2
  dvTotal: number;
  tof: number; // transfer time (s) — half the transfer-ellipse period
  mode: "hohmann" | "bi-elliptic";
}

/**
 * Cost to move a circular orbit from radius `r1` to `r2` about `mu`, optionally rotating the
 * orbit plane by `di` (rad). The plane change is combined with the circularization burn at
 * max(r1, r2) via the velocity-triangle law (`combinedPlaneChangeDv`). With `di = 0` this is the
 * plain Hohmann and `dv1`/`dv2` match `hohmann()` exactly.
 */
export function orbitRaise(mu: number, r1: number, r2: number, di = 0): OrbitRaise {
  const h = hohmann(mu, r1, r2);
  const aT = (r1 + r2) / 2; // transfer-ellipse semi-major axis
  let dv1 = h.dv1;
  let dv2 = h.dv2;
  if (di !== 0) {
    if (r2 >= r1) {
      // Raising: the second burn is at the higher radius r2 (transfer apoapsis) — fold the
      // plane change there.
      dv2 = combinedPlaneChangeDv(visVivaSpeed(mu, r2, aT), circularSpeed(mu, r2), di);
    } else {
      // Lowering: the first burn is at the higher radius r1 (transfer apoapsis) — fold it there.
      dv1 = combinedPlaneChangeDv(circularSpeed(mu, r1), visVivaSpeed(mu, r1, aT), di);
    }
  }
  return { dv1, dv2, dvTotal: dv1 + dv2, tof: h.tof, mode: "hohmann" };
}
