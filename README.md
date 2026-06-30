# LIGHTLAG

A space-based strategy sim with one inviolable rule: **physics is never hand-waved.**
Relativity, the rocket equation, the speed of light, thermodynamics, materials limits — none
of it is decoration. It's the whole game.

You command a spacefaring effort across a real, to-scale Solar System. You will never see the
present (light takes minutes to hours to reach you) and you can never directly fly the distant
(you send instructions that crawl outward at *c*). You move mass by paying real Δv out of a real
propellant budget, on transfer windows dictated by orbital geometry, while shedding waste heat
that no amount of engineering can wish away.

> Single-player sandbox. The antagonist is physics.

## The five pillars (all consequences of real physics)

1. **Command under light-lag** — your view of each object is a *retarded snapshot*, delayed by
   `distance / c`. Commands propagate at `c` and are acknowledged a round-trip later. The map is
   the past.
2. **The rocket equation is the economy** — wealth is mass, Δv, energy, and heat, not money.
   `Δv = vₑ·ln(m₀/m_f)`. Staging, propellant depots, and shallow gravity wells are strategy.
3. **Orbital mechanics is the clock** — Hohmann/Lambert transfers, synodic launch windows, the
   Oberth effect. The reachable map pulses with planetary geometry.
4. **Thermodynamics is inescapable** — waste heat can only be radiated (`P = εσAT⁴`). Power →
   radiator area → IR signature → detection range. There is no real stealth in space.
5. **Materials & energy set the ceilings** — specific power (kW/kg) caps acceleration, solar
   power falls as `1/r²`, tensile strength caps tethers and spin gravity.

## Status

**Phases 1–6 + core-mechanics expansion complete** — a deterministic physics engine and a
flyable, to-scale 3D Solar System.

- Real JPL ephemeris for **110 bodies** — the 8 planets; the dwarf planets and large TNOs; a
  deep moon roster (the Galileans plus Jupiter's inner Amalthea group and classical irregulars;
  Titan + the major Saturnians plus the ring-shepherds, co-orbitals, Hyperion and Phoebe; the
  five major Uranians plus Puck, Portia, Cressida and the irregular Caliban/Sycorax; Triton plus
  Neptune's inner regulars and eccentric Nereid; Phobos/Deimos; the Pluto system — Charon and the
  four small moons Styx/Nix/Kerberos/Hydra, which orbit the Pluto–Charon barycentre); the small-body
  populations — the **main asteroid belt** (Ceres, Vesta, Psyche, … 18 in all), **near-Earth
  asteroids** (433 Eros, Bennu, Ryugu, Itokawa, Apophis), the **Jupiter Trojans** (Hektor,
  Patroclus, …), the **Kuiper belt** (Pluto, Quaoar, Orcus, Varuna, Ixion, …), the **scattered
  disc** (Eris, Gonggong) and a taste of the **inner Oort cloud** (Sedna, Leleākūhonua);
  comets (1P/Halley, 2P/Encke); and the major man-made satellites (ISS, Hubble, Tiangong).
  Every orbit is a real Horizons J2000 osculating conic, propagated analytically (exact at any
  time-warp) and cross-checked at J2000 vs Horizons; GM/radius/rotation are Horizons physical
  parameters where published.
- **Light-lag command** — the thesis of the game: commands propagate from Earth at `c`; your view
  of every ship is a retarded snapshot (delayed by `distance / c`), and orders are acknowledged
  only a round-trip later. A NACK arrives if the ship can't execute (out of propellant, wrong
  frame). Telemetry replies propagate back at `c` the same way.
- **Transfer toolkit**: Hohmann, Lambert (multi-revolution), porkchop launch windows, bi-elliptic
  transfers, plane changes, and **gravity-assist flybys** — including **multi-flyby chains**:
  plan an Earth→Mars→Jupiter→Saturn tour and watch the heliocentric energy jump at *each*
  slingshot (every bend is free). One- and two-flyby missions fly in-sim via patched-conic
  geometry. The **mission planner** has a grouped destination list (planets / dwarfs / asteroids
  / comets / moons), an **Optimize for** selector (least Δv · shortest flight · balanced) that
  moves the porkchop crosshair, and a **Suggest** button that auto-searches the workhorse
  gravity-assist routes (incl. VEEGA-style chains) and ranks them — or pick the flybys yourself.
  **Moons are real destinations**: from a planet orbit you can transfer to its moons (LEO → the
  Moon, Jupiter orbit → a Galilean, Saturn orbit → Titan) — a parent-centric Lambert (J2-aware,
  so even a gas giant's oblateness is honoured) that flies in-sim and captures into a
  lunar/Galilean parking orbit (LEO → lunar orbit ≈ 4.2 km/s). And a moon of *another* planet is a
  one-click **two-stage mission**: pick Europa from Earth and the planner commits a heliocentric
  Stage-1 leg to Jupiter that **auto-chains** the parent-centric Europa leg the instant the ship
  captures at Jupiter — Earth → Jupiter → Europa from a single Commit. **Capture geometry is a
  choice**: at any propulsive arrival — a direct transfer *or a gravity-assist/chain arrival* — you
  pick a low **circular** orbit, an Oberth-cheap **loose ellipse** (low periapsis, apoapsis at ~½ the
  SOI), or an **aerocapture** drag pass where there's an atmosphere — the way real orbit insertions
  are flown. This is what makes the classic outer-planet *orbiters* (Cassini, Galileo, a Voyager-style
  tour) actually flyable: a Saturn arrival via a Jupiter slingshot captures for **~0.3 km/s** of
  elliptical insertion instead of the **~11 km/s** a low circular orbit demands — the difference
  between a realistic spacecraft completing the mission and stranding itself on a hyperbola past the
  planet. The planner shows the saving live.
- **Landing & takeoff** Δv/propellant budgeting: a calibrated gravity-turn ascent through real
  exponential atmospheres (Earth→LEO ≈ 9.3 km/s, Moon ≈ 1.9, Mars ≈ 4.0), aerobraking on
  descent, and ships that sit on the surface co-rotating with the body.
- **Launch vehicles fly the ascent**: a preset's `role` says where it starts. A **launch
  vehicle** (Saturn V, Falcon 9/Heavy, Shuttle, Soyuz, Ariane, Starship…) stands on the Earth
  pad and must climb to LEO — its boost/lower stages are **expended in the ascent**, so only the
  surviving payload + orbital stage reaches orbit (a Saturn V leaves the S-IVB **plus the Apollo
  CSM's own engine** in orbit — the S-IVB throws the stack to the Moon and the CSM inserts into
  lunar orbit, ~5 km/s in hand, with the Command + Lunar Modules as inert cargo). Roll it out and fly the gravity turn,
  or **express to LEO** to resolve the ascent instantly. An **in-space craft** (upper/kick stages,
  probes, nuclear/electric tugs) is delivered to LEO as payload, so it deploys directly into orbit
  with full propellant. The designer shows the live ascent budget and the projected orbital
  survivor, and gates launch on it — a launcher carrying more than it can lift is told so.
- **Atmospheric-entry heating & aerocapture**: a real ballistic entry trajectory integrated
  through the exponential atmosphere — peak deceleration (cross-checked against Allen-Eggers),
  Sutton-Graves convective stagnation heat flux, radiative-equilibrium wall temperature, and
  the integrated heat load that sizes a heat shield. Aerocapture solves the single-pass
  corridor that captures a hyperbolic arrival into a bound orbit, saving nearly the whole
  propulsive capture burn (a Mars arrival captures for ~10 m/s of trim instead of ~2 km/s).
  When a ship's orbit dips into the atmosphere you can **Fly entry** — ride the drag
  trajectory down in-sim, watching altitude, speed, g-load, and heat flux build at any
  time-warp, ending in a landing, a skip-out, or an aerocapture — a deterministic, save-safe
  leg (no teleport). And a transfer can **aerocapture on arrival**: pick CAPTURE MODE →
  Aerocapture in the planner and the ship sheds its arrival speed in a single atmospheric
  pass, capturing into orbit for a small periapsis-raise trim (a Mars arrival captures for
  ~80 m/s instead of a ~2.5 km/s burn).
- **Electric (low-thrust) propulsion**: power-limited ion/Hall drives whose real thrust is
  `min(F_rated, 2ηP/vₑ)` with solar power falling as 1/r² — fly a multi-month Edelbaum spiral
  from LEO to GEO (or any near-circular orbit), charged up front and exact at any time-warp.
- **Interstellar** first steps: a relativistic propulsion layer (rapidity rocket equation +
  constant-proper-accel brachistochrone), the ~24 nearest star systems, a transit estimator, and
  an in-sim flyable flip-and-burn where the crew clock and Earth clock visibly diverge — torchships
  include the Project Hail Mary astrophage **spin drive** (a near-photon torch).
- **Ship lifecycle**: a ship flown into a body (e.g. a retrograde burn that drops periapsis below
  the surface) **crashes and is lost** — destroyed at the analytic surface crossing and frozen as a
  wreck, with the flight console reporting CONTACT LOST. Ships can be **deleted** outright, and a
  planned transfer offers **Warp to departure** — jump the clock to just before a delayed departure
  instead of fast-forwarding by hand.
- **Orbital logistics — propellant transfer & in-orbit construction**: the SpaceX-tanker / depot
  architecture, gated on a **true rendezvous** (two craft sharing a primary, co-located in position
  and matched in velocity — co-orbital ships qualify exactly). A **propellant transfer** moves mass
  between docked hulls, conserving it exactly and capped at the receiver's as-built tank capacity, so
  it raises the receiver's m₀ → Δv = vₑ·ln(m₀/m_f) and lowers the donor's — Δv is *moved*, never
  conjured. **In-orbit assembly** dock-merges two craft into one: the added ship's stages stack on
  top and its payload sums in (mass conserved), so you build a deep-space vehicle in orbit instead of
  launching it whole out of a gravity well. Both are driven from the flight console's **DOCK /
  TRANSFER** panel. (The natural partner to the launch model above: lift payloads/modules to LEO —
  launchers expending their boost stages in the climb — then fuel and assemble them into a deep-space
  vehicle in orbit.)
- **Thermal & detection** — there is no stealth in space: hull temperature (Stefan-Boltzmann),
  IR signature, and a defensible **SNR-vs-range** detection curve are live readouts. The
  detection model is the radiometer equation — a real detector noise-equivalent power,
  an integration time τ, a 5σ threshold, and background photon shot noise — so range
  improves only as τ^(1/4) and √(aperture) and still falls only as √(signature). A cold
  hull is visible ~0.1 AU off; a thrusting drive is a beacon across tens of AU.
- **J2 oblateness**: secular nodal/apsidal precession applied analytically at read time (exact at
  any time-warp); sun-synchronous inclination helper.
- **Preset ship catalog**: 30+ real and inferred designs across Historical / Current / Prototype /
  Sci-Fi categories — Saturn V, Falcon 9, ion tugs, Daedalus, photon drives — every number from
  published data, no tuning for balance.
- Floating-origin + logarithmic-depth rendering for solar-system-scale precision in float32.
- Time warp from real-time to 1 yr/s, a live calendar, body focus, and physics readouts
  (orbital period, heliocentric speed, surface gravity/escape velocity, one-way light-time).
- **Deterministic serialize/hash**: `serializeWorld` / `hashWorld` for golden-state CI checks
  and as the foundation for Phase-8 save/load.

See [ROADMAP.md](ROADMAP.md) for the full feature backlog and candidate next phases.

### Physics honesty

The physics is never hand-waved, and where it is approximated that is written down:

- [docs/error-budget.md](docs/error-budget.md) — how large the residual error is,
  regime by regime (LEO, interplanetary, entry, interstellar…), with the numbers
  harvested from the test suite.
- [docs/deliberate-omissions.md](docs/deliberate-omissions.md) — what is consciously
  *not* modelled, the alternatives weighed, and why — so an approximation is never
  mistaken for an oversight.
- [docs/physics-audit.md](docs/physics-audit.md) /
  [docs/physics-assessment.md](docs/physics-assessment.md) — the correctness audits.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Controls:

| Key(s) | Action |
|---|---|
| Drag / WASD / ↑↓←→ | Orbit camera |
| Scroll / `+` `-` | Zoom |
| Space | Pause / resume |
| `,` / `.` | Slower / faster time-warp |
| `1`–`8` | Focus Sun, Mercury, Venus, Earth, Moon, Mars, Jupiter, Saturn |
| Tab / Shift+Tab | Cycle focus forward / backward through all 110 bodies |
| `F` | Toggle ship designer & flight console |
| `V` | Cycle camera view angle (isometric → top-down → edge-on) |
| `M` | Toggle system ⇄ interstellar view |
| `R` / Home | Reset camera distance for current focus |
| `?` | Toggle help overlay (keyboard reference) |
| Escape | Close the open planner / help / ship panel (in that order) |
| `◐` (button) | Toggle light / dark theme |

Show / hide is in the **FOCUS** panel: an eye toggle on each body (and each
group header) hides that object or the whole group — a kind, a planetary system,
or a small-body region, depending on how the list is ordered — and a chip row
toggles the cross-cutting layers — orbit lines, labels, the nearby-star sky,
ships, and in-flight comms.

The **FOCUS** panel also orders its body list four ways (the choice persists),
with a realtime search box above it (type to filter; Enter jumps to the first
match, Esc clears):

- **Type** — grouped by kind (planets, dwarfs, asteroids, moons, satellites,
  comets), the default.
- **System** — grouped by parent system: the Sun, then each planet with its
  moons & satellites nested beneath it, Pluto with Charon, then the far
  heliocentric bodies. (This is where the LEO stations — ISS, Hubble, Tiangong —
  read as Earth's satellites rather than a loose bucket.)
- **Near** — ordered by live distance to the focused body: your own system
  first with the parent body leading it, then every other system nearest-first,
  re-sorting whenever you change focus.
- **Region** — splits the heliocentric small bodies into their dynamical
  populations — near-Earth asteroids, the main belt, the Jupiter Trojans, the
  Kuiper belt, the scattered disc and the Oort cloud — each a show/hide group
  (the header eye reveals or hides the whole population at once), with the
  planets, moons, satellites and comets grouped as in Type.

## Develop

```bash
npm install            # wires the workspace (links @lightlag/engine)
npm test               # vitest — the physics engine is tested hard (engine + game)
npm run typecheck      # strict TypeScript over the whole repo, no emit
npm run typecheck:engine  # DOM-free engine-only check — the boundary gate
npm run build          # static, zero-install production bundle
```

## Architecture

The single rule that everything rests on: **the simulation engine is a pure, deterministic,
double-precision SI module with zero renderer dependencies. Three.js only ever *reads* it.**
The engine is its own workspace package (`@lightlag/engine`); the game is a thin layer on
top. Dependencies point inward only — the engine imports nothing from the game.

```
packages/engine/src/     @lightlag/engine — pure f64 SI physics. No three.js, no DOM,
  (imported by the game as @lightlag/engine/<module>, e.g. @lightlag/engine/orbit,
   or via the namespaced barrel: import { orbit, sim } from "@lightlag/engine")
    math/
      vec3.ts            f64 vector ops ({x,y,z}, serializable)
      kepler.ts          Kepler solvers, coe↔rv, propagation
      integrators.ts     RK4 for powered flight
      relativity.ts      special-relativistic coordinate accel (relativistic powered flight)
    maneuver/
      lambert.ts         Lambert solver (single + multi-revolution)
      hohmann.ts         Hohmann transfer + synodic period
      porkchop.ts        launch-window sweep (Lambert grid)
      biElliptic.ts      bi-elliptic transfer
      arrival.ts         B-plane hyperbolic approach targeting
      flyby.ts           gravity-flyby geometry
      assist.ts          two-leg gravity-assist solver + grid search
      moon.ts            parent-centric moon transfer-window search (J2-aware)
      moonTour.ts        parent-centric moon gravity-assist flyby chains
      suggest.ts         auto-route suggester (direct / assist / VEEGA chain), ranked
      criteria.ts        trajectory scoring (least-Δv / shortest / balanced)
      lowThrust.ts       Edelbaum analytic spiral (electric, power-limited)
      entry.ts           ballistic entry heating (Sutton-Graves) + aerocapture
      interstellar.ts    relativistic brachistochrone + transit estimator
    constants.ts         physical constants + body catalog (JPL elements, μ, radii)
    ephemeris.ts         analytic body state at any t
    orbit.ts             vis-viva, maneuver frame, SOI, Oberth, J2 precession rates
    propulsion.ts        rocket equation, staging, Δv budget, electric power law, tank capacity
    ships.ts             ship helpers: state, mass, Δv, thermal readout
    refuel.ts            rendezvous-gated propellant transfer + in-orbit assembly
    surface.ts           landing/takeoff Δv: gravity-turn, atmospheres, aerobraking
    thermal.ts           Stefan-Boltzmann, solar flux, detection range
    forces.ts            force/momentum breakdown for the overlay (gravity, tidal, velocity)
    trajectory.ts        live ship forecast path from osculating elements
    route.ts             heliocentric Lambert route geometry for visualization
    stars.ts             nearest ~24 star systems in ecliptic-J2000 frame
    comms.ts             light-time, signal propagation at c, retarded state
    serialize.ts         canonical world serialization + hashWorld (golden-state oracle)
    time.ts              clock, time-warp levels, event queue, calendar
    world.ts             WorldState — plain serializable data (the save format)
    sim.ts               step kernel: time advance, RK4, event dispatch, light-lag command delivery
src/                     the game layer — depends on @lightlag/engine
  render/                three.js read-only view — never feeds back into the engine
    SceneManager.ts      scene, camera, renderer, floating origin, OrbitControls
    bodyViews.ts         body meshes, orbit lines (phased through the marker), label anchors
    bodyTextures.ts      procedural seeded surface textures (no image assets)
    bodyFeatures.ts      real IAU surface-feature tables drawn over the texture base
    earthLand.ts         real Earth coastline polygons → land/sea mask
    shipViews.ts         ship meshes + floating name labels
    starViews.ts         nearby real-star markers (the only sky; no procedural starfield)
    interstellarView.ts  the interstellar map: nearby systems about Sol + ships in transit
    trajectoryViews.ts   ship forecast / planned-route / preview-ghost overlays
    forceViews.ts        gravity & momentum vector overlay for the focused object
    commsViews.ts        light-cone / signal-in-flight visualizations
    overlayUtil.ts       shared overlay primitives (polylines, arrows, palette)
    visibility.ts        shared show/hide state (per-body, per-kind, per-layer)
    scale.ts             metre ↔ render-unit conversion, logarithmic depth
  ui/                    DOM panels over the WebGL canvas
    hud.ts               clock, warp, body list + show/hide layers, readouts, labels, theme
    shipPanel.ts         ship designer, flight console, surface ops, electric spiral, thermal
    transferPanel.ts     porkchop plot, gravity-assist via mode, commit
    interstellarPanel.ts star picker, torchship selector, transit estimator, dispatch
    keyboard.ts          shortcuts + smooth per-frame camera orbit/zoom
    dom.ts               shared DOM builders (auto-tag glossary terms)
    collapsible.ts       persistent disclosure sections
    popover.ts           anchored flyout panels (e.g. the Layers menu)
    tooltip.ts           hover/focus glossary definition cards
    glossary.ts          physics-true term definitions (single source)
    scaleBar.ts          cartographic scale-bar overlay
    uiState.ts           persisted UI layout state (localStorage)
  app/                   wiring
    main.ts              entry point + the one-way frame loop
    commands.ts          player intents → validated world mutations
    shipCatalog.ts       30+ preset designs (Historical / Current / Prototype / Sci-Fi)
  integration/           app↔engine integration tests (sim / integration / j2 + test-helpers)
```

Determinism is a feature: state is plain serializable data, advanced only by `sim.step()`; the
renderer and HUD never feed back into it. No `Date.now()` or `Math.random()` in the engine.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the dependency rules, the engine contract, how to
build another game on `@lightlag/engine`, and the workspace layout.

## License

TBD.
