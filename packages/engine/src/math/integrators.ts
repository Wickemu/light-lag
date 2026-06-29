/**
 * Numerical integration for powered flight.
 *
 * Coasting is analytic (Kepler) and never touched here. But a ship under thrust
 * has continuously varying mass and a non-conservative force, so its trajectory
 * must be integrated. We use classical RK4 (4th-order Runge-Kutta): forward
 * Euler is first-order and non-conservative — it pumps energy into an orbit and
 * visibly spirals it outward — so it is never used for dynamics.
 *
 * State is a flat number[] so the same integrator serves any state layout; the
 * derivative function closes over whatever context (mass model, thrust) it needs.
 */

export type Derivative = (t: number, y: number[]) => number[];

/** y + s·k, elementwise. */
function axpy(y: number[], k: number[], s: number): number[] {
  const out = new Array<number>(y.length);
  for (let i = 0; i < y.length; i++) out[i] = y[i]! + s * k[i]!;
  return out;
}

/** One classical RK4 step of size dt. Returns the new state. */
export function rk4(y: number[], t: number, dt: number, f: Derivative): number[] {
  const k1 = f(t, y);
  const k2 = f(t + dt / 2, axpy(y, k1, dt / 2));
  const k3 = f(t + dt / 2, axpy(y, k2, dt / 2));
  const k4 = f(t + dt, axpy(y, k3, dt));
  const out = new Array<number>(y.length);
  for (let i = 0; i < y.length; i++) {
    out[i] = y[i]! + (dt / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!);
  }
  return out;
}
