import { describe, it, expect } from "vitest";
import { createWorld, type Ship } from "./world.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "./serialize.ts";

function mkShip(id: string, primary = "earth"): Ship {
  return {
    id, name: id, primary, mode: "coast",
    elements: { a: 7.0e6, e: 0.01, i: 0.5, Omega: 1, omega: 2, M: 3 },
    epoch: 0, payloadMass: 1000,
    stages: [{ name: "S1", dryMass: 1000, propMass: 5000, isp: 300, thrust: 1e5 }],
    activeStage: 0, tau: 0,
  };
}

describe("canonical serialization", () => {
  it("is independent of Map insertion order (the core determinism property)", () => {
    const w1 = createWorld(1, 0);
    w1.ships.set("ship-b", mkShip("ship-b"));
    w1.ships.set("ship-a", mkShip("ship-a"));

    const w2 = createWorld(1, 0);
    w2.ships.set("ship-a", mkShip("ship-a"));
    w2.ships.set("ship-b", mkShip("ship-b"));

    expect(hashWorld(w1)).toBe(hashWorld(w2));
  });

  it("quantizes away sub-quantum jitter but catches real change", () => {
    const w = createWorld(1, 0);
    w.ships.set("a", mkShip("a"));
    const h0 = hashWorld(w);

    w.ships.get("a")!.elements!.a += 7e-8; // ~1e-14 relative — below the 12-sig-fig quantum
    expect(hashWorld(w)).toBe(h0);

    w.ships.get("a")!.elements!.a += 7e-3; // ~1e-9 relative — a real change
    expect(hashWorld(w)).not.toBe(h0);
  });

  it("omits absent optionals (no transfer/burn keys for a plain coasting ship)", () => {
    const w = createWorld(1, 0);
    w.ships.set("a", mkShip("a"));
    const s = serializeWorld(w);
    expect(s).not.toContain("transfer");
    expect(s).not.toContain("burn");
  });

  it("round-trips through deserialize and is hash-stable", () => {
    const w = createWorld(7, 12345);
    w.ships.set("a", mkShip("a"));
    w.ships.set("b", { ...mkShip("b"), transfer: { targetId: "mars", tDepart: 1, tArrive: 2, dvDepart: 3, dvArrive: 4, departed: true, inSoi: false, arrived: false } });
    w.stations.set("st", { id: "st", name: "Sta", primary: "earth", elements: { a: 8e6, e: 0, i: 0, Omega: 0, omega: 0, M: 0 } });

    const s1 = serializeWorld(w);
    const w2 = deserializeWorld(s1);
    expect(serializeWorld(w2)).toBe(s1);
    expect(hashWorld(w2)).toBe(hashWorld(w));
    expect(w2.ships.get("b")!.transfer!.targetId).toBe("mars");
    expect(w2.t).toBe(w.t);
  });
});
