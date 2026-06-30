import { describe, it, expect } from "vitest";
import { integratePerturbed, perturbedSampleAt, selectPerturbers, type PerturbedParams } from "./perturbed.ts";
import { BODY_BY_ID, MU_SUN, DAY, JULIAN_YEAR, DEG } from "./constants.ts";
import { type Vec3, sub, scale, cross, normalize, length, dot } from "./math/vec3.ts";
import { stateToElements, elementsToState, propagate, period } from "./math/kepler.ts";
import { spinAxis } from "./ships.ts";
import { lagrangeState } from "./maneuver/lagrange.ts";

const earth = BODY_BY_ID.get("earth")!;
const moon = BODY_BY_ID.get("moon")!;
const muE = earth.mu;

/** A circular orbit state of radius r about a body of GM mu, in the plane normal to `pole`. */
function circular(r: number, mu: number, pole: Vec3): { r0: Vec3; v0: Vec3 } {
  const x: Vec3 = { x: 1, y: 0, z: 0 };
  const rHat = normalize(sub(x, scale(pole, dot(x, pole)))); // x projected ⟂ pole
  const vHat = normalize(cross(pole, rHat));
  const vc = Math.sqrt(mu / r);
  return { r0: scale(rHat, r), v0: scale(vHat, vc) };
}

/** Angle (rad) between two vectors. */
function angBetween(a: Vec3, b: Vec3): number {
  const c = dot(a, b) / (length(a) * length(b));
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

describe("perturbed integrator — two-body oracle", () => {
  it("with no perturbers and no J2, every raw sample matches a Kepler propagation to <1 m over one orbit", () => {
    const { r0, v0 } = circular(4.216e7, muE, { x: 0, y: 0, z: 1 }); // GEO-radius, ecliptic plane
    const el0 = stateToElements(r0, v0, muE);
    const T = period(el0.a, muE);
    const res = integratePerturbed({ mu: muE, primaryId: "earth", t0: 0, r0, v0, horizon: T, perturbers: [] });
    let maxErr = 0;
    for (const s of res.samples) {
      const kep = elementsToState(propagate(el0, muE, s.t), muE).r;
      maxErr = Math.max(maxErr, length(sub(s.r, kep)));
    }
    expect(maxErr).toBeLessThan(1); // pure RK4 vs analytic Kepler, sub-metre over a full revolution
  });
});

describe("perturbed integrator — determinism", () => {
  it("is a pure function: identical params ⇒ byte-identical samples", () => {
    const { r0, v0 } = circular(4.216e7, muE, spinAxis(earth));
    const p: PerturbedParams = {
      mu: muE, primaryId: "earth", t0: 0, r0, v0, horizon: 20 * DAY,
      perturbers: [{ id: "moon", mu: moon.mu }, { id: "sun", mu: MU_SUN }],
    };
    expect(JSON.stringify(integratePerturbed(p).samples)).toBe(JSON.stringify(integratePerturbed(p).samples));
  });

  it("horizon-independence: a 2H forecast sampled at H matches the H forecast's exit", () => {
    const { r0, v0 } = circular(4.216e7, muE, spinAxis(earth));
    const base = { mu: muE, primaryId: "earth", t0: 0, r0, v0, perturbers: [{ id: "moon", mu: moon.mu }] };
    const H = 10 * DAY;
    const short = integratePerturbed({ ...base, horizon: H });
    const long = integratePerturbed({ ...base, horizon: 2 * H });
    const atH = perturbedSampleAt(long.samples, H);
    const rel = length(sub(short.exitR, atH.r)) / length(short.exitR);
    expect(rel).toBeLessThan(1e-3); // both trace the same path; difference is only interpolation
  });
});

describe("perturbed integrator — GEO lunisolar benchmark", () => {
  it("Moon-on-GEO peak tidal acceleration is ~1e-5 of Earth's central pull, with the right magnitude", () => {
    const rGeo = 4.216e7;
    const aCentral = muE / (rGeo * rGeo);
    // Peak geocentric Moon tidal accel ≈ 2·μ_moon·r/d³ (d = mean Earth–Moon distance).
    const ratio = (2 * moon.mu * rGeo) / Math.pow(3.84e8, 3) / aCentral;
    // eslint-disable-next-line no-console
    console.log(`GEO Moon tidal/central ratio ≈ ${ratio.toExponential(2)}`);
    expect(ratio).toBeGreaterThan(1e-6);
    expect(ratio).toBeLessThan(1e-4);
  });

  it("lunisolar perturbation drifts the GEO inclination at ~0.85°/yr (textbook), vs exactly 0 with no perturbers", () => {
    const rGeo = 4.216e7;
    const pole = spinAxis(earth); // equatorial-plane GEO: orbit normal starts along the Earth pole
    const { r0, v0 } = circular(rGeo, muE, pole);
    const span = 60 * DAY;
    const perturbers = [{ id: "moon", mu: moon.mu }, { id: "sun", mu: MU_SUN }];
    // Start at a J2000 epoch where the Moon is well off the equator so the torque is representative.
    const t0 = 100 * DAY;

    const withLS = integratePerturbed({ mu: muE, primaryId: "earth", t0, r0, v0, horizon: span, perturbers });
    const noLS = integratePerturbed({ mu: muE, primaryId: "earth", t0, r0, v0, horizon: span, perturbers: [] });

    const normal = (s: { r: Vec3; v: Vec3 }): Vec3 => cross(s.r, s.v);
    const incLS = angBetween(normal(withLS.samples[withLS.samples.length - 1]!), pole) / DEG;
    const incNo = angBetween(normal(noLS.samples[noLS.samples.length - 1]!), pole) / DEG;
    const ratePerYr = incLS / (span / JULIAN_YEAR);
    // eslint-disable-next-line no-console
    console.log(`GEO inclination after ${span / DAY}d: lunisolar=${incLS.toFixed(4)}°, none=${incNo.toExponential(2)}°, rate≈${ratePerYr.toFixed(3)}°/yr`);

    expect(incNo).toBeLessThan(1e-3); // pure two-body keeps the plane fixed
    expect(ratePerYr).toBeGreaterThan(0.3); // lunisolar drift, textbook ~0.85°/yr
    expect(ratePerYr).toBeLessThan(1.6);
  });
});

describe("perturbed integrator — Sun–Earth L2 (the Lagrange gap)", () => {
  it("a craft at L2 follows a materially different path when it feels Earth than the two-body coast does", () => {
    const t0 = 50 * DAY;
    const st = lagrangeState(earth, "L2", t0); // heliocentric absolute state of Sun–Earth L2
    const r0 = st.r, v0 = st.v;
    const span = 40 * DAY;
    const withEarth = integratePerturbed({
      mu: MU_SUN, primaryId: "sun", t0, r0, v0, horizon: span,
      perturbers: [{ id: "earth", mu: earth.mu }],
    });
    const twoBody = integratePerturbed({ mu: MU_SUN, primaryId: "sun", t0, r0, v0, horizon: span, perturbers: [] });
    const divergence = length(sub(withEarth.exitR, twoBody.exitR));
    // eslint-disable-next-line no-console
    console.log(`Sun–Earth L2 divergence (feels-Earth vs two-body) after ${span / DAY}d ≈ ${(divergence / 1e6).toFixed(1)} Mm`);
    expect(divergence).toBeGreaterThan(1e6); // Earth's pull near L2 is dynamically significant — the gap
    // Sanity: still ~1 AU from the Sun (didn't fly off absurdly).
    expect(length(withEarth.exitR)).toBeGreaterThan(1.4e11);
    expect(length(withEarth.exitR)).toBeLessThan(1.6e11);
  });
});

describe("selectPerturbers", () => {
  it("for an Earth-orbit ship includes the Sun and the Moon, id-sorted and deterministic", () => {
    const ps = selectPerturbers("earth", 0);
    const ids = ps.map((p) => p.id);
    expect(ids).toContain("sun");
    expect(ids).toContain("moon");
    expect(ids).toEqual([...ids].sort()); // frozen id-sorted order
    expect(selectPerturbers("earth", 0).map((p) => p.id)).toEqual(ids); // deterministic
  });
});
