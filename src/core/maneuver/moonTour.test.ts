import { describe, it, expect } from "vitest";
import { searchMoonTour, moonTour } from "./moonTour.ts";
import { searchMoonWindow } from "./moon.ts";
import { bodyElements } from "../ephemeris.ts";
import { propagate, elementsToState } from "../math/kepler.ts";
import { BODY_BY_ID } from "../constants.ts";

const JUP = BODY_BY_ID.get("jupiter")!;
const EUROPA = BODY_BY_ID.get("europa")!;

// A loose, eccentric Jupiter orbit roughly coplanar with the Galileans (peri ~1.2 Gm, apo ~4.8 Gm)
// — the kind of orbit a ship settles into after a cheap elliptical capture, ready to pump down.
// Pure two-body about Jupiter (the solver takes whatever state function it's given).
function jupiterLooseOrbit() {
  const el0 = bodyElements(EUROPA, 0)!;
  const el = { a: 3e9, e: 0.6, i: el0.i, Omega: el0.Omega, omega: el0.omega, M: 0 };
  return {
    el,
    shipState: (t: number) => elementsToState(propagate(el, JUP.mu, t), JUP.mu),
  };
}

describe("intra-system moon tour (parent-centric flyby pump-down at Jupiter)", () => {
  const { el, shipState } = jupiterLooseOrbit();
  // Pin the grid so the result is reproducible regardless of future default-tuning.
  const search = { tDepart: 0, shipState, steps: 5, phaseSteps: 32 };

  it("finds a Ganymede-flyby tour to Europa that captures far cheaper than a direct hop", () => {
    const tour = searchMoonTour("jupiter", ["ganymede"], "europa", search)!;
    expect(tour).toBeTruthy();
    expect(tour.flybys.length).toBe(1);
    expect(tour.flybys[0]!.moonId).toBe("ganymede");
    // Internal consistency + ordered schedule.
    expect(tour.dvTotal).toBeCloseTo(tour.dvDepart + tour.dvFlybyTotal + tour.dvArrive, 3);
    expect(tour.times.length).toBe(3); // [depart, ganymede, arrive]
    for (let i = 1; i < tour.times.length; i++) expect(tour.times[i]!).toBeGreaterThan(tour.times[i - 1]!);

    // The mechanism: the flyby does the velocity-matching, so capture about Europa is cheap — a
    // fraction of the low-circular burn a direct arrival from the loose ellipse must pay. This is
    // the real headline (the roadmap's "a few hundred m/s of trim, not a multi-km/s burn").
    const direct = searchMoonWindow("jupiter", "europa", 0, shipState, el.a)!;
    expect(direct).toBeTruthy();
    expect(tour.dvArrive).toBeLessThan(0.6 * direct.dvArrive); // matched-velocity capture is much cheaper
    expect(tour.dvFlybyTotal).toBeLessThan(1500); // the bend is mostly free
    // An optimally-phased direct hop (searchMoonWindow now sweeps the full parking-orbit period,
    // so it finds the cheap apoapsis departure) can match the TOTAL — but only by paying the whole
    // bill as a brutal capture burn at Europa, where a small arrival stage can least afford it. The
    // tour stays in the same ballpark on total while shifting that cost into a cheap departure + a
    // near-free bend; the capture saving (asserted above) is the real headline.
    expect(tour.dvTotal).toBeLessThan((direct.dvDepart + direct.dvArrive) * 1.2);
  });

  it("each flyby's required turn is within the geometric maximum a safe pass provides", () => {
    const tour = searchMoonTour("jupiter", ["ganymede"], "europa", search)!;
    for (const f of tour.flybys) {
      expect(f.turnRequired).toBeLessThanOrEqual(f.turnMax + 1e-9); // a free bend is available
      expect(f.unpowered).toBe(f.dvFlyby < 1);
    }
    expect(tour.unpowered).toBe(tour.flybys.every((f) => f.unpowered));
  });

  it("captures into a loose ellipse for less than a circular capture (captureApoAlt)", () => {
    const tour = searchMoonTour("jupiter", ["ganymede"], "europa", search)!;
    const dep = shipState(tour.times[0]!);
    const circ = moonTour("jupiter", dep, ["ganymede"], "europa", tour.times)!;
    const ell = moonTour("jupiter", dep, ["ganymede"], "europa", tour.times, 5e6)!;
    expect(circ).toBeTruthy();
    expect(ell).toBeTruthy();
    expect(ell.dvArrive).toBeLessThan(circ.dvArrive); // Oberth-cheap elliptical insertion
  });

  it("solves a two-flyby tour (Callisto → Ganymede → Europa)", () => {
    const tour = searchMoonTour("jupiter", ["callisto", "ganymede"], "europa", search)!;
    expect(tour).toBeTruthy();
    expect(tour.flybys.map((f) => f.moonId)).toEqual(["callisto", "ganymede"]);
    expect(tour.times.length).toBe(4);
    expect(isFinite(tour.dvTotal)).toBe(true);
  });

  it("rejects degenerate inputs", () => {
    const dep = shipState(0);
    expect(moonTour("jupiter", dep, ["ganymede"], "europa", [0, 1e6])).toBeNull(); // wrong times length
    expect(moonTour("jupiter", dep, ["ganymede"], "europa", [0, 1e6, 5e5])).toBeNull(); // out-of-order
    expect(moonTour("jupiter", dep, ["titan"], "europa", [0, 1e6, 2e6])).toBeNull(); // wrong parent
    expect(moonTour("jupiter", dep, ["ganymede"], "titan", [0, 1e6, 2e6])).toBeNull(); // target not a Jovian moon
    expect(searchMoonTour("jupiter", [], "europa", search)).toBeNull(); // no flyby moons
  });
});
