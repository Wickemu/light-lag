/**
 * A small, offline seed of real two-line element sets so the sandbox shows live
 * satellites with no network. The full catalog comes from the opt-in Celestrak
 * fetch (see satellites.ts `fetchCelestrak`). These are real TLEs; a TLE is only
 * accurate near its epoch, so an analytically-propagated orbit drifts from the
 * true satellite over days — the sandbox labels this.
 *
 * Attribution: orbital data courtesy of CelesTrak (https://celestrak.org).
 */
export interface Tle {
  name: string;
  line1: string;
  line2: string;
}

export const TLE_ATTRIBUTION = "Orbital data courtesy of CelesTrak (celestrak.org).";

/** Seed set. The canonical ISS element set (the satellite.js reference TLE) is
 *  kept first and is covered by the ingestion test. */
export const TLE_SNAPSHOT: Tle[] = [
  {
    name: "ISS (ZARYA)",
    line1: "1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927",
    line2: "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537",
  },
];
