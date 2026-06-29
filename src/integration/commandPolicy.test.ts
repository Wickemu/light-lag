/**
 * Light-lag command policy: the sandbox's "informative" mode applies a commanded
 * burn immediately (the delay is a readout), while the strategy game's default
 * "binding" mode propagates it at c and delivers it later. Each policy is
 * internally deterministic; they legitimately differ (the binding burn starts a
 * light-delay later). An app↔engine integration test (drives the command layer).
 */
import { describe, it, expect } from "vitest";
import { Simulation } from "@lightlag/engine/sim";
import { createWorld } from "@lightlag/engine/world";
import { hashWorld } from "@lightlag/engine/serialize";
import { spawnShip, defaultDesign, sendBurn } from "../app/commands.ts";

function leoSim(policy: "binding" | "informative"): { sim: Simulation; shipId: string } {
  const sim = new Simulation(createWorld(42, 0, "earth"));
  sim.commandPolicy = policy;
  const shipId = spawnShip(sim, defaultDesign());
  return { sim, shipId };
}

describe("light-lag command policy", () => {
  it("informative applies the burn immediately; binding defers it", () => {
    const inf = leoSim("informative");
    const delay = sendBurn(inf.sim, inf.shipId, 50, "prograde");
    expect(typeof delay).toBe("number"); // the readout delay
    expect(inf.sim.world.ships.get(inf.shipId)!.mode).toBe("thrust"); // applied NOW
    expect(inf.sim.world.messages.length).toBe(0); // no in-flight comms state

    const bnd = leoSim("binding");
    sendBurn(bnd.sim, bnd.shipId, 50, "prograde");
    expect(bnd.sim.world.ships.get(bnd.shipId)!.mode).toBe("coast"); // queued, not delivered
    expect(bnd.sim.world.messages.length).toBe(1); // command in flight
  });

  it("each policy is internally deterministic, and the two differ", () => {
    const run = (policy: "binding" | "informative"): string => {
      const { sim, shipId } = leoSim(policy);
      sendBurn(sim, shipId, 50, "prograde");
      sim.step(3600);
      return hashWorld(sim.world);
    };
    expect(run("informative")).toBe(run("informative"));
    expect(run("binding")).toBe(run("binding"));
    expect(run("informative")).not.toBe(run("binding"));
  });
});
