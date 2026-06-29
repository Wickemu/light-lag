/**
 * The sandbox controller: the orbital playground's state on top of the engine —
 * the light-lag policy toggle, the live-satellite catalog, and the replay
 * transport. Thin glue so the app wires one object and the UI drives it.
 */
import type { Simulation } from "@lightlag/engine/sim";
import { spawnSatellites, fetchCelestrak, type Tle } from "./satellites.ts";
import { TLE_SNAPSHOT, TLE_ATTRIBUTION } from "./data/tleSnapshot.ts";
import { ReplayController } from "./replay.ts";

export class Sandbox {
  readonly replay: ReplayController;
  /** Ids of the satellites this sandbox has ingested (for clearing / counts). */
  satelliteIds: string[] = [];
  readonly attribution = TLE_ATTRIBUTION;

  constructor(private sim: Simulation, onChange?: () => void) {
    this.replay = new ReplayController(sim, { onChange });
  }

  get policy(): "binding" | "informative" {
    return this.sim.commandPolicy;
  }
  setPolicy(p: "binding" | "informative"): void {
    this.sim.commandPolicy = p;
  }

  /** Ingest the bundled offline TLE seed. Returns how many loaded. */
  loadSeedSatellites(): number {
    return this.ingest(TLE_SNAPSHOT);
  }

  /** Ingest a live Celestrak group (network; opt-in). Returns how many loaded. */
  async loadLiveSatellites(group = "stations"): Promise<number> {
    return this.ingest(await fetchCelestrak(group));
  }

  private ingest(tles: Tle[]): number {
    const ids = spawnSatellites(this.sim, tles);
    this.satelliteIds.push(...ids);
    return ids.length;
  }

  clearSatellites(): void {
    for (const id of this.satelliteIds) this.sim.world.ships.delete(id);
    this.satelliteIds = [];
  }
}
