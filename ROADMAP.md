# LIGHTLAG — roadmap

**Status:** Phases 1–6 complete; core-physics hardening pass complete (ephemeris
tightening + Horizons cross-check, integration-invariant suite, golden-state
determinism, and an adversarial cross-subsystem audit with its confirmed findings
fixed). The reusable physics engine is `src/core/` (see
[ARCHITECTURE.md](ARCHITECTURE.md)); 557 passing physics/sim tests — including a
JPL Horizons ephemeris cross-check, cross-subsystem conservation/SOI-continuity
(entry **and** egress) invariants, off-nominal flyby + abort handling, and a
golden-state determinism hash.

Built so far: real ephemeris + Keplerian orbits, the rocket equation + staging +
RK4 powered flight, transfer planning (Lambert / Hohmann / porkchop / real launch
windows), patched-conic SOI capture, light-lag command (the thesis), and
thermal / power / detection ("no stealth in space"). Plus parallel-session
add-ons: a 30-craft preset catalog and keyboard controls.

**Core-mechanics expansion (latest):** the full Solar System — 50 bodies total:
the 8 planets, the dwarf planets (Ceres, Pluto, Eris, Haumea, Makemake), major
asteroids (Vesta, Pallas, plus 433 Eros, 10 Hygiea, 3 Juno), the Kuiper-belt
flyby target Arrokoth, gas-giant & other moons (Galileans, Titan + six
Saturnians, five Uranians, Triton, Phobos/Deimos, Charon), TNOs + comets
(Sedna, Quaoar, Gonggong, Orcus, 1P/Halley, 2P/Encke), and major man-made
satellites (ISS, Hubble, Tiangong — a new `satellite` body class), each on a
JPL-validated ephemeris;
**landing & takeoff** Δv/propellant budgeting (a calibrated gravity-turn ascent
through real atmospheres, with aerobraking on descent — now extended with a full
**atmospheric-entry heating** trajectory and single-pass **aerocapture**); and the first
**interstellar** layer — relativistic propulsion (rapidity rocket equation +
constant-proper-accel brachistochrone), a ~24-system nearby-star catalog
(~12 ly radius, ecliptic-J2000 frame, drifting under real proper motion), a transit
estimator, and an in-sim flyable flip-and-burn with crew/Earth time dilation.

## Completed — core physics hardening

Not a feature phase. With every physics layer in place, verify them *together*:
cross-subsystem conservation/continuity invariants, end-to-end mission accounting,
and golden-state determinism. Goal (achieved): the physics core is provably correct
and locked by a permanent integration test suite before more gameplay is layered on.

Delivered: JPL Horizons ephemeris cross-check, conservation/SOI-continuity invariants
(entry **and** egress), off-nominal flyby + abort handling, golden-state determinism
hash (`hashWorld`), and an adversarial cross-subsystem audit with all confirmed
findings fixed. **The physics core is locked.**

## Coming phases (address soon)

### Phase 7 — Mass economy · resources · depots · colonization
- Wealth is **mass, energy, Δv, heat** — never abstract money.
- **Propellant depots + refueling**: docking transfers propellant, raising m₀ → Δv.
- **ISRU**: mine volatiles (water ice from comets/moons/regolith) → propellant +
  life support; everything traces back to energy.
- A **colony/base** with supply requirements that must be resupplied within a
  transfer window; missing the window has consequences.
- v1 resource cap: propellant, structure, life-support mass (~3 resources).

### Phase 8 — Polish · persistence · determinism-in-CI
- Versioned **save/load**: `serializeWorld` / `deserializeWorld` are done
  (`WorldState` round-trips cleanly); the remaining gap is re-scheduling the
  `EventQueue` (capture / SOI / message-arrival events) after a restore.
- **Golden-state determinism** test in CI (`hashWorld` is implemented; wire into a
  headless CI harness).
- HUD/legibility pass; onboarding / tutorialized vertical slice; light + dark verified.

## Next core-mechanics round — candidate priorities (highest-leverage first)

A curated, ranked view *into* the backlog below — the threads most worth picking up
next, after five expansion rounds (Solar System + landing → assists + toolkit → J2 →
electric propulsion → parallel staging). Each round stays additive: pure SI, deterministic,
read-time analytic, suite green, golden hash documented if it moves.

1. **B-plane-targeted in-sim pass + J2 on the planetary approach** — the in-sim flyby/aerocapture
   passes use a patched-conic point + charged residual rather than a B-plane-targeted trajectory;
   and the heliocentric→planet capture hyperbola (`aimArrival`) is still pure two-body even at an
   oblate giant (the moon aim `aimMoonArrival` is now J2-aware — bring the planet aim to parity).
   *(see "Gravity assists" and "J2 oblateness".)*
2. **Parent-centric porkchop + eccentric capture everywhere** — moon legs (`searchMoonWindow`)
   pick a single coarse-grid window and the auto-chained / same-parent moon captures still
   circularize; give moon transfers a proper porkchop plot (like the heliocentric one) and thread
   the existing optional `captureApoAlt` through `searchMoonWindow` / `maybeChainMoonLeg` so a
   moon capture can also choose the cheap loose ellipse. (The moon flyby TOUR already threads
   `captureApoAlt` and searches a small parent-centric grid; this brings the single-hop window
   to parity.) *(see "Transfer toolkit".)*
3. **Follow ships (and other objects) in the interstellar view** — entering the interstellar map
   hard-locks the camera target to Sol (`SceneManager.frameInterstellar` sets `controls.target` to
   the origin). Let it follow an interstellar-leg ship instead: add an optional focus id to
   `setViewMode` / a per-frame `updateFocus()` hook the interstellar view calls, have
   `interstellarView.update` drive `setFocusTarget` from the scaled ship position when one is
   selected, and surface ship selection in the HUD. Respect the view-mode isolation invariant
   (the interstellar view computes its own positions about Sol). *(Observation #2.)*
4. **ISRU / depots (Phase 7)** — mass economy: propellant depots + refueling, ISRU from
   moon/comet/regolith volatiles, and a colony supplied within a transfer window. *(see Phase 7.)*

*(**Animated launch / landing trajectories** — candidate #3 last round — is now DONE; see the
"Done since last round" note below.)*

*(Done since last round: **animated launch / landing trajectories (no more snapping)** —
`launchShip`/`landShip` no longer teleport the ship between the surface and its parking orbit; the
powered ascent/descent now FLIES in-sim as a read-time leg. New optional `LaunchLeg` / `DescentLeg`
(`world.ts`, parallel to `EntryLeg`) carry a compact spline `[t, altitude, speed, flight-path-angle,
downrange-angle]` sampled ONCE from the gravity-turn budget integrator at commit: `surface.ts`
`ascentBudget` gained a decoupled downrange-angle (θ) state — `dθ/dt = v·cosγ/r`, feeding back into
nothing so every budget number is byte-identical — plus an optional sampler; `descentBudget` flies the
AIRLESS powered descent as that ascent spline **time-reversed** (a powered landing is the kinematic
mirror of a powered ascent), while atmospheric arrivals keep using the drag-pass `EntryLeg`
(`flyEntry`) so the entry-heating physics is never duplicated. `shipRelativeState` /
`shipOsculatingElements` gained dispatch branches (`poweredLegState`) that interpolate the stored
spline (O(log n)) and reconstruct the 3D arc with the EXACT `planeBasis`/`reconstructEntry` geometry
the entry leg uses. `launchShip`/`landShip` charge the Δv at commit, build the leg
(`buildLaunchLeg`/`buildDescentLeg`), clear the old state, and schedule a `launch-arrive` /
`land-arrive` finalize (`sim.ts arriveLaunch`/`arriveLand`, mirroring `finishEntry`) that seats the
ship on the pinned parking orbit / co-rotating touchdown site; a degenerate climb (drag-stalled, or an
absurd burn time) falls back to the old instant snap. The arc renders for FREE via `shipForecastPath`
(the forecast horizon caps at the arrive event, so the drawn arc stops exactly at touchdown/insertion).
The arc altitude is rescaled to connect the surface to the requested parking orbit, and the exit is
pinned to the arc's downrange end, so surface↔orbit is position-continuous — a flown arc, not a snap.
All new state is optional ⇒ **golden hash unmoved**; the stored spline + scheduled finalize ⇒
chunk-invariant (a new `app/launchLeg.test.ts` checks one-step ≡ chunked and a mid-arc serialize
round-trip; the existing `surfaceOps.test.ts` now steps through the arc before asserting the landed /
orbit state). *(Candidate #3; Observation #5. Still to do: a live ASCENDING/DESCENDING HUD readout, and
optional in-atmosphere powered-descent animation distinct from the ballistic entry pass.)*)*

*(Earlier — Done since prior round: **playtest-feedback round (lifecycle, hazards, content, camera)** —
seven observations from real play, landed additively (suite green: +21 tests; golden hash
unmoved — all new state is optional and serializes only when present). **(1) Ships now crash and
are lost** on flying their orbit into a body: `sim.step` analytically finds the surface-crossing time
of any coasting conic (J2-consistent mean motion, so it is chunk-invariant — a new
`shipLifecycle.test.ts` checks one-step ≡ chunked) and freezes the ship as a wreck at the impact
site with `Ship.status="lost"`; the flight console shows CONTACT LOST and offers only deletion.
**(2) Delete a ship** (`deleteShip`) removes it and purges its in-flight orders, scheduled events
(`EventQueue.removeByEntity`), and maneuver records — the renderer drops its visuals on its own.
**(3) Warp-to-departure** (`Simulation.jumpToTime`, thrust-safe) + a flight-console button leaps the
clock to ~5 min before a planned transfer's departure instead of hand-cranking the warp. **(4) The
LEO-launch strobe is gone**: focus now frames the PARENT body (not the ship) whenever chasing it
would strobe — measured as revolutions-per-real-second at the current warp, so a ship is watched
circling Earth rather than flickering around it. **(5) Interstellar ships in the system view** sit on
the same unzoomable celestial-sphere backdrop as the stars (true Sun→ship direction) instead of a
wrong, parallaxing finite range. **(6) Content:** 433 Eros, 10 Hygiea, 3 Juno, and the Kuiper flyby
target Arrokoth (JPL J2000 osculating elements); the ISS, Hubble, and Tiangong as a new `satellite`
body class; and the Project Hail Mary astrophage **spin drive** (a near-photon torch) in the
interstellar craft catalog. **Deferred from this round:** animated launch/landing arcs and the
interstellar follow-cam (candidates 3 & 4 above — they need new world state + spline/camera
plumbing and deserve their own rounds); plus the smaller hazard follow-ups in the backlog.)*

*(Earlier — Done since prior round: **intra-system gravity-assist tours (moon-flyby orbit pump-down)** — the
real way deep-well orbiters reach a moon, now flyable: capture into a loose ellipse about a planet
(already supported), then slingshot past the planet's moons to ratchet the apoapsis down toward the
target moon — the Galileo / JUICE / Europa Clipper technique. The whole assist stack was keyed to
the heliocentric frame; this adds a **parent-centric twin**. A new `maneuver/moonTour.ts` evaluates a
fixed schedule (`moonTour`) and bounded-grid-searches the cheapest tour (`searchMoonTour`), reusing
the frame-agnostic `flybyManeuver` and the J2-aware `aimMoonArrival` for the final capture aim; unlike
a heliocentric assist the ship is already in orbit about the parent, so the departure is a DIRECT
impulse (not an origin-well escape) and the search samples the ship's REAL (loose, eccentric) conic.
The in-sim executor (`sim.ts`) gained an `executeMoonTourDeparture` and a parent-frame branch in
`executeFlyby` (parent.mu, parent-relative moon states, `ship.primary` stays the planet — the ship
never leaves the SOI), and `exitSoi` is now frame-symmetric so an off-nominal moon-tour egress
re-patches to the parent, not the Sun; the existing moon-aware `enterSoi` / `captureAtPeriapsis`
finish the capture (circular or — threading `captureApoAlt` — a loose ellipse). The planner gains a
**Flyby tour** mode (a Direct-hop / Flyby-tour toggle for same-parent moons with ≥2 siblings) that
auto-searches and ranks sibling-moon flyby sequences. A Jupiter-orbit ship reaches a low Europa orbit
via a Ganymede flyby for a ~0.4 km/s (near-free) bend and a ~1.4 km/s capture — a fraction of the
low-circular burn a direct arrival from the loose ellipse pays. The tour reuses only existing optional
`ShipTransfer` fields (`central` + `flybys` + `captureApoAlt`) ⇒ no world-state change, golden hash
unmoved; impulsive + analytic-coast + scheduled-event ⇒ chunk-invariant (new `moonTour.ts` and
`app/moonTour.test.ts` check one-step ≡ chunked and a clean serialize round-trip). *(Note: a first-cut
bounded search — capped at ≤3 flyby moons over a curated sibling set; deeper multi-flyby resonant tour
optimization remains future work.)* Earlier: **capture geometry for gravity-assist & chain arrivals** — the
Oberth-cheap elliptical insertion (and aerocapture, where there's an atmosphere) was wired to direct
transfers but NOT to the gravity-assist/chain solvers, so an assist arrival at a giant could only
force a ~17 km/s low-circular capture — which a realistically-fuelled orbiter can't afford, stranding
it on a hyperbola past the planet. Now `planAssist` / `planChainAssist` take a `captureMode` +
`captureApoAlt` (the assist solvers expose `vInfArrive`; a shared `resolveAssistCapture` picks the
burn), the in-sim `executeFlyby` aims the final-leg periapsis into the atmosphere for aerocapture, and
the planner's CAPTURE MODE control now shows for the flyby route modes. A Cassini-class Earth → Jupiter
→ Saturn tour captures into an eccentric Saturn orbit for **~0.3 km/s** instead of ~11 km/s — the real
deep-well SOI-insertion technique, now flyable end-to-end. All new fields are optional ⇒ golden hash
unmoved; impulsive + scheduled-event ⇒ chunk-invariant (a fresh `assistCapture.test.ts` checks the
one-step ≡ chunked hash). **Planner budget honesty (follow-up):** the feasibility gate now scores the
WHOLE mission Δv (injection + flyby + capture), not just the injection. Previously the planner
green-lit a deep-well arrival on a low-circular capture the ship couldn't afford (e.g. an
Earth → Jupiter → Europa mission showing a 17.9 km/s Stage-1 Jupiter capture against a ~9.8 km/s ship,
labelled "✓ injection within budget") — committing it would strand the craft on a hyperbola at arrival.
The readout now warns "✗ capture Δv exceeds remaining budget — try a loose-ellipse or aerocapture
arrival" and disables Commit until the chosen capture actually fits (a `budgetVerdict` helper applied
across the direct / mission / assist / chain branches), turning the impossible 24 km/s low-circular plan
into a feasible ~7 km/s loose-ellipse one. Earlier: **Oberth-cheap elliptical capture** — `captureAtPeriapsis` no
longer always circularizes; a transfer can capture into a loose, eccentric ellipse (low periapsis,
apoapsis at ~½ the SOI) via a new optional `ShipTransfer.captureApoAlt` + `ellipticalCaptureDv`,
which is how real deep-well orbit insertions are flown — burning at the low periapsis where the
Oberth effect is strongest and shedding only enough energy to drop just below escape. A Jupiter
arrival captures for a few km/s instead of the ~17 km/s a low circular capture demands; the
planner's CAPTURE MODE gains a "loose ellipse (cheap)" option that shows the saving live
(`looseCaptureApoAlt`, `captureDvPreview`). Absent field ⇒ classic circular capture ⇒ golden hash
unmoved. *(Note: the full Galilean-flyby orbit pump-down — using a parent's moons to ratchet down
the capture ellipse for free — remains open; the intra-system flyby planner is future work.)*
Earlier: **mission-planner overhaul + moons as destinations** — the transfer
planner was rebuilt around the engine's full capability: grouped, origin-aware destination &
flyby lists (every body, Earth now selectable as a gravity-assist body — the VEEGA bug fixed),
an **Optimize for** selector (least Δv · shortest flight · balanced, a total-ordering scorer in
`criteria.ts`) that moves the porkchop crosshair and ranks the assist/chain sweeps, and a
**Suggest** button that auto-searches the workhorse flyby routes (`suggest.ts`). **Moons became
real destinations**: a same-parent moon flies a parent-centric Lambert (`planMoonTransfer`,
`ShipTransfer.central`) that captures into a lunar/Galilean parking orbit, and a moon of
*another* planet is a one-click **cross-system two-stage mission** (`planMoonMission`,
`ShipTransfer.thenMoonId`) — a heliocentric Stage-1 leg to the parent planet that the sim
**auto-chains** into the parent-centric moon leg on capture (Earth → Jupiter → Europa). The
B-plane moon aim (`aimMoonArrival`) is J2-aware so a gas giant's oblateness doesn't drift the
short hop out of the moon's small SOI, and `searchMoonWindow` scores cells with that same aim so
the window it picks is one the sim can actually fly. All new state is optional ⇒ golden hash
unmoved; impulsive + analytic-coast + scheduled-event ⇒ chunk-invariant. Earlier:
**in-sim aerocapture on arrival** — a transfer can capture at a
body with an atmosphere by flying the drag pass instead of a propulsive burn. `planTransfer`
takes a capture mode; aerocapture aims the arrival hyperbola's periapsis INTO the atmosphere
(`aeroPeriAlt`, from the `aerocapture()` corridor solver), `enterSoi` flies the entry leg at
the interface crossing instead of scheduling a propulsive `capture`, and `finishEntry` raises
periapsis at the first apoapsis for a small trim Δv — a Mars arrival captures for ~80 m/s of
trim instead of a ~2.5 km/s burn (the transfer planner's CAPTURE MODE toggle shows the
saving). Earlier: **in-sim chained multi-flyby executor** — a planned multi-flyby
tour (e.g. Earth→Mars→Jupiter→Saturn) now FLIES in-sim, not just costed: `ShipTransfer.flybys`
is an ordered chain, the executor walks it (each pass bends the heliocentric velocity for free
and aims the next leg at the following flyby body, or the target after the last), `planChainAssist`
+ a bounded `searchChain` schedule it, and the transfer planner gains a second "VIA FLYBY 2"
dropdown that draws and commits a two-flyby chain (see "Gravity assists"). Earlier:
**in-sim flyable entry pass** — a coasting ship whose orbit dips
into the atmosphere can be flown down in-sim ("Fly entry") instead of teleported: a new
read-time `EntryLeg` integrates the ballistic drag trajectory deterministically from the
interface crossing (planar, lift = 0, reusing the entry.ts EOM), watchable at any time-warp
with a live altitude / speed / g / heat-flux / wall-temp readout, ending in landed / captured
/ skip-out (see "Landing / takeoff"). Earlier: **defensible SNR-vs-range detection curve** —
the IR detection model is now the radiometer equation: a real detector NEP (W/√Hz), an
explicit integration time τ, an explicit SNR threshold (5σ), and background photon shot noise,
giving an honest SNR(d) curve that falls as 1/d² (see "Detection model"). Earlier:
**aerocapture + atmospheric-entry heating** — a full ballistic
entry trajectory RK4-integrated through the exponential atmosphere, reporting peak
deceleration, the Sutton-Graves convective stagnation heat flux, the radiative-equilibrium
wall temperature, and the integrated heat load that sizes a TPS; plus single-pass
aerocapture that bisects the entry corridor to capture a hyperbolic arrival into a bound
orbit and reports the Δv it saves vs a propulsive burn (see "Landing / takeoff"). Earlier:
**parallel staging / strap-on boosters** — a stage can carry
strap-on boosters that ignite with it and burn concurrently at the thrust-weighted
vₑ_eff = F/ṁ, each dropping as it empties while the core keeps firing; honest Δv budget,
in-sim concurrent-burn integrator, and Falcon Heavy / Space Shuttle / Soyuz / Ariane 5
presets (see "Parallel staging" below). Earlier rounds: **in-system relativistic
finite-thrust burns** — the in-sim integrator composes velocity as a rapidity (capped below
c), burns propellant at a constant proper-time rate, and tracks delivered Δv as rapidity,
reducing to the classical integrator to f64 at sub-relativistic speeds; **stellar proper
motion**; low-thrust **capture/escape spirals** + **variable-Isp throttling**; **multi-flyby
assist chains** + analytic **free-bend B-plane targeting**.)*

These are candidates, not a commitment — pick the highest-leverage one when the next round
starts. Lower-priority refinements (N-body/J3 perturbations, a defensible SNR-vs-range
detection curve, comet outgassing, drop-tank cross-feed) live in the backlog entries below.

## Backlog — known engine gaps (future layers)

- **Spacecraft hazards & lifecycle** — surface-impact loss is DONE for coasting conics
  (`sim.impactTime`/`crashShip`: a ship whose orbit dips below the primary's radius is
  destroyed at the analytic surface crossing and frozen as a wreck). Follow-ups:
  (a) **intra-burn collision** — a ship thrusting *into* the surface is only caught when the
  burn ends and it next coasts; detect `|r| ≤ R` inside `advanceThrustShip` for a powered
  crash too. (b) **entry-leg terrain collision** — `integrateEntryPlanar` could gain an
  `outcome:"crashed"` when a too-steep/too-shallow descent reaches altitude ≤ 0 at lethal
  speed, distinct from a controlled landing. (c) **render frame-skip at extreme warp** — the
  parent-body focus default removes the LEO chase-strobe, but a fast object still visibly
  jumps frame-to-frame; skip the redraw (or motion-blur) when the focused entity moved < ~1px
  since last frame. (d) collision with *other ships*/stations (rendezvous gone wrong) is a
  larger, separate feature.
- **Relativistic propulsion** — DONE (first cut): rapidity rocket equation,
  constant-proper-accel brachistochrone, time dilation / proper-time divergence,
  and an in-sim flyable interstellar leg; `PENDING_RELATIVISTIC` is now the flyable
  `INTERSTELLAR_CRAFT` roster. **In-system relativistic finite-thrust burns — DONE:**
  the in-sim integrator (`sim.advanceThrustShip`) is now special-relativistic —
  `properToCoordinateAccel` (`math/relativity.ts`) turns the proper-frame specific
  force (thrust + gravity) into the coordinate 3-acceleration, so velocity composes as
  a rapidity and is capped below c; propellant burns at a constant *proper-time* rate
  (`−ṁ/γ`, integrated so the rapidity ledger telescopes and the burn stays
  chunk-invariant on the grid); and `burn.dvDone`/`dvTarget` are a delivered/target
  rapidity (`ve·ln(m₀/m_f)`). It reduces to the classical integrator to f64 at the
  sub-relativistic speeds every preset ship flies (golden hash unchanged). Still to do:
  multi-leg coast cruises rendered in-sim, and a time-optimal in-system relativistic
  trajectory planner. (**Stellar proper motion — DONE**; see its own entry below.)
- **Power-limited electric thrust** — DONE: an `ElectricSource {powerW, eta, solar}`
  on a stage drives the *actual* thrust `F = min(F_rated, 2ηP/vₑ)`, with solar power
  falling as 1/r² toward the Sun (reactor power constant); the ship console reads
  out drive power (kW @ AU) and live thrust/accel. Long electric transfers are flown
  as an analytic Edelbaum spiral leg (`Δv = √(v0²+v1²−2v0v1·cos(½π·Δi))`, semi-major
  axis linear, phase in closed form) — committed with Δv/propellant charged up front
  and exact at any time-warp, rather than an impractical months-long stepped burn.
  Five solar-electric + one VASIMR craft ship with the catalog.
  **Capture/escape spirals — DONE:** the analytic Edelbaum leg now takes the r→∞
  limit to spiral a single body's well — `spiralEscapeDv`/`spiralCaptureDv` (= the
  local circular speed, e.g. ~7.7 km/s to spiral off LEO, more than the impulsive
  `(√2−1)·v_circ` but cheap in propellant at electric Isp) and their
  `…Transfer` legs (Δv/time/propellant). The heliocentric spiral arrives matched
  (vInf ≈ 0), so the well-spiral is internally consistent: a rendezvous, not a
  braking burn. **Variable-Isp throttling — DONE:** `variableIspBurn` operates a
  constant-power drive at a chosen exhaust velocity (`F = 2ηP/vₑ`), making the
  thrust↔Isp↔time trade explicit (`exhaustForThrust`/`jetPower` helpers). Still to
  do: an *in-sim flyable* capture/escape spiral (the analytic leg lands first) and
  a time-optimal variable-Isp control law.
- **Parallel staging** — DONE: a `Stage` can carry strap-on `boosters` (an
  independent engine+tank, with a `count` for identical units) that ignite WITH it
  and burn concurrently. The Δv budget (`stageDeltaV`/`deltaVBudget`) decomposes a
  boostered stage into parallel sub-phases at the thrust-weighted vₑ_eff = F/ṁ,
  each reservoir dropping as it empties (the core's dry mass held until the stage
  ends; a booster that outlasts the core keeps pushing the dead core). The in-sim
  integrator (`sim.advanceBoosteredSegment`) flies it as N concurrent reservoirs in
  one RK4 state vector on a single rapidity ledger, splitting exactly at each
  reservoir-empty; once the last booster drops it falls through to the untouched
  serial path. `consumeStageDv` shares the phase model with the budget so the
  impulsive affordability check and the actual burn can never disagree. Serial
  stacks (and the golden scenario) are byte-identical — the golden hash did not
  move. Five presets ship it: Falcon Heavy, Space Shuttle, Soyuz, Ariane 5 (plus
  the genuinely-serial Vega). **Still to do:** drop-tank cross-feed (a no-engine
  reservoir feeding the core — folded into the core stage today, e.g. the Shuttle's
  ET), and a planner-UI hint when a launcher's boostered first stage is fired from
  LEO (boost stages don't fly in-game).
- **Gravity assists** — DONE: flyby physics (flyby.ts), a two-leg patched-conic
  assist solver (assist.ts), and in-sim execution (a flyby-pass that bends the
  heliocentric velocity for free and continues to the target), with a "via flyby"
  planner mode. **Multi-flyby chains — DONE:** `chainAssist` evaluates an arbitrary
  origin→fb₁→fb₂→…→target tour (e.g. V-E-E-G-A) for a fixed schedule — a Lambert arc
  per leg, the free-or-bridged flyby model at each interior body, and a full Δv
  ledger; it generalizes `assistTransfer` (the n=1 case, reproduced exactly).
  **Free-bend B-plane targeting — DONE (analytic):** `bPlaneAim` solves the
  hyperbola that rotates v∞_in into v∞_out's direction (e = 1/sin(δ/2), rp, impact
  parameter b, and the B-vector/plane-normal aim geometry); `impactParameter` gives
  b = rp·√((e+1)/(e−1)). **In-sim chained executor — DONE:** `ShipTransfer.flybys` is
  an ordered chain (the single flyby is a 1-element array), and `sim.ts::executeFlyby`
  walks it — each scheduled `flyby-pass` bends the heliocentric velocity for free,
  aims the next leg at the FOLLOWING flyby body (Lambert) and schedules the next pass,
  or aims at the target (B-plane capture) and schedules SOI-crossing after the last.
  `planChainAssist` records the chain and a bounded `searchChain` grid-searches the
  per-leg times-of-flight around their Hohmann estimates; the transfer planner's new
  "VIA FLYBY 2" dropdown draws and commits a two-flyby chain. Impulsive + analytic-coast,
  so chunk-invariant (one-step ≡ chunked) and golden-hash-neutral (the absent `flybys`
  field doesn't touch the direct-transfer golden scenario). **Intra-system (parent-centric) flyby
  tour — DONE:** the same geometry now generalizes from the heliocentric frame to a planet's μ with
  its **moons** as the assist bodies (`maneuver/moonTour.ts` — `moonTour` evaluates a fixed schedule,
  `searchMoonTour` bounded-grid-searches the cheapest, reusing `flybyManeuver` and the J2-aware
  `aimMoonArrival`). The in-sim executor walks moon `flyby-pass` events *inside* the planet's SOI
  (`executeMoonTourDeparture` + a parent-frame branch in `executeFlyby`; `ship.primary` stays the
  planet throughout, `exitSoi` re-patches to the parent on an off-nominal egress). It unlocks the real
  deep-well orbiter playbook — capture into a loose ellipse (see "elliptical capture") then pump the
  apoapsis down with repeated Galilean / Saturnian flybys (Galileo, JUICE, Europa Clipper), the bend
  doing the velocity-matching so the moon capture is cheap (a Jupiter-orbit ship reaches a low Europa
  orbit via a near-free Ganymede flyby for a ~1.4 km/s capture). Surfaced in the planner as a **Flyby
  tour** mode. Reuses only existing optional `ShipTransfer` fields (`central` + `flybys` +
  `captureApoAlt`) ⇒ golden hash unmoved; impulsive + analytic-coast + scheduled-event ⇒
  chunk-invariant. Still to do: a B-plane-targeted in-sim pass (it uses a patched-conic point +
  charged residual); a full chain porkchop (the UI searches TOF multipliers around Hohmann timings,
  not an exhaustive window sweep); and deeper multi-flyby resonant tour optimization (the tour search
  is a first-cut bounded grid capped at ≤3 flyby moons over a curated sibling set).
- **Transfer toolkit** — DONE: plane-change Δv, bi-elliptic transfers, and
  multi-revolution Lambert (wired into the porkchop).
- **J2 oblateness** — DONE: secular nodal/apsidal precession of ship/station
  orbits about oblate bodies (orbit.ts j2Rates), applied analytically at read time
  (exact at any time-warp; golden-hash-neutral), with a sun-synchronous-inclination
  helper. The **moon-arrival aim is now J2-aware** (`aimMoonArrival` propagates the
  parent-centric cruise with the parent's J2, matching `coastElements` — a gas giant's
  oblateness no longer drifts the short hop out of a moon's small SOI). Still to do: full N-body
  perturbations, J3+ harmonics, and bringing the **heliocentric→planet** capture aim
  (`aimArrival`) to the same J2 parity (its approach hyperbola is still pure two-body).
- **Full B-plane targeting in the planner UI** — the analytic aim (`bPlaneAim`:
  free-bend hyperbola, impact parameter, B-vector) now exists; what remains is
  surfacing it in the planner UI and a B-plane-targeted in-sim pass (B-plane solved
  at execution today).
- **SOI-as-point departure** (parking-orbit offset dropped) — documented
  approximation; refine if close-range nav matters.
- **Validity window past 1800–2050** (the giants' 3000 BC–3000 AD b,c,s,f
  libration terms). Evaluated during the hardening pass and deferred: the JPL
  3000 BC–3000 AD table trades in-window precision for range, and the engine's
  era is the 21st century, where the 1800–2050 model is more accurate (confirmed
  vs Horizons). Worth revisiting only if far-future/ancient play is prioritized.
- **Detection model** — DONE: single-band IR + reflected, now a defensible
  **SNR-vs-range curve** via the radiometer equation (`thermal.ts SensorSpec`).
  A detector noise-equivalent power `NEP` (W/√Hz) folded over the post-detection
  bandwidth Δf = 1/(2τ) gives a noise power `NEP/√(2τ)`, in quadrature with the
  background photon shot noise `√(P_bg·hν/τ)`; a detection needs the collected
  power to clear `SNR_threshold × noise`, so `d_max = √(P·A_tel/(4π·P_min))` and
  `snrAtRange` is the 1/d² curve (equal to the threshold exactly at d_max).
  Defaults: 1 m² aperture, NEP 1e-16, τ = 1 h, 5σ, a 10 µm band. The in-beam
  zodiacal+CMB background is kept aperture-independent by the diffraction-limited
  étendue A·Ω = λ². Range improves only as **τ^(1/4)** and √(aperture), shortens as
  √(SNR), and still falls only as √(signature) — no stealth in space; the burn/coast
  ratio is unchanged, but absolute ranges grew (the integrated NEP is far below the
  old fixed 1e-14 W floor: a cold hull ~0.13 AU, a thrusting drive ~24 AU). Pure
  read-time readout — golden hash unmoved. Still to do: a second optical band split
  (reflected-sunlight vs thermal-IR with separate apertures/backgrounds) and a
  diffraction-limited angular-resolution / astrometric model.
- **Landing / takeoff** — DONE: a calibrated gravity-turn ascent Δv budget through
  real exponential atmospheres + an aerobraking descent model, with in-sim
  land/launch and co-rotating landed ships (sit on the surface at surface speed).
  **Aerocapture + atmospheric-entry heating — DONE** (`maneuver/entry.ts`): a real
  ballistic entry trajectory, RK4-integrated through the same exponential atmosphere,
  yielding the peak deceleration (β-independent, cross-checked against Allen-Eggers),
  the **Sutton-Graves** convective stagnation-point heat flux `q = k·√(ρ/R_n)·v³`
  (air vs CO₂ coefficient), the radiative-equilibrium wall temperature `T = (q/εσ)^¼`,
  and the integrated heat load `∫q dt` (TPS sizing); the atmospheric interface sits at
  11 scale heights so the discarded upper-atmosphere drag is negligible. Outcomes
  classify as land / capture / skip-out from the exit energy. **Aerocapture** wraps the
  same integrator in a deterministic bisection on the entry flight-path angle to find
  the single-pass corridor that leaves a hyperbolic arrival bound at a target apoapsis,
  reporting the Δv saved vs the propulsive capture burn (`orbit.ts hyperbolicBurnDv`)
  minus a small post-pass periapsis-raise trim — pure functions, no world state, golden
  hash unmoved; the descent panel shows the live peak-g / heat-flux / wall-temp / heat-load
  readout. **In-sim flyable entry pass — DONE** (`world.ts EntryLeg`, `ships.ts
  entryLegState`/`buildEntryLeg`, `commands.ts flyEntry`, `sim.ts` entry-start/entry-end
  events): a coasting ship whose orbit dips below the atmospheric interface can be flown
  down in-sim ("Fly entry") instead of teleported. `flyEntry` finds the interface crossing
  (`entry.ts entryInterfaceCrossing`) and schedules the pass; at the crossing the ship flies
  a ballistic (no-propellant) drag trajectory carried as a read-time **deterministic** leg —
  the same `entry.ts` EOM integrated as a planar `[h, v, γ, θ]` state and reconstructed into
  the orbital plane, re-derived from a fixed start so it is exact at any time-warp (one-step
  and chunked runs hash identically) and golden-hash-neutral (a new optional `EntryLeg`
  field, absent from the golden scenario). It ends in landed (co-rotating touchdown) /
  captured (settles onto the post-pass orbit) / skip-out, with a live altitude / speed / g /
  heat-flux / wall-temp / heat-load readout in the ship panel. **In-sim aerocapture on
  arrival — DONE** (`world.ts ShipTransfer.aeroPeriAlt`, `commands.ts planTransfer` capture
  mode + `aerocapturePreview`, `sim.ts` enterSoi/finishEntry + the `aero-trim` event): an
  interplanetary transfer can capture at an atmosphere-bearing body by flying the drag pass
  instead of a propulsive burn. The injection aims the arrival hyperbola's periapsis INTO the
  atmosphere (the `aerocapture()` corridor solver picks it); at SOI entry the entry leg flies
  the pass instead of a propulsive `capture`; and a trim burn at the first apoapsis raises
  periapsis clear of the atmosphere (`tr.arrived`). A Mars arrival captures for ~80 m/s of
  trim instead of a ~2.5 km/s burn — the transfer planner's CAPTURE MODE toggle shows the
  saving (disabled for airless targets). Impulsive + read-time-leg + impulsive-trim, so
  chunk-invariant and golden-hash-neutral. **Animated launch / landing arcs — DONE**
  (`world.ts LaunchLeg`/`DescentLeg`, `ships.ts buildLaunchLeg`/`buildDescentLeg`/`poweredLegState`,
  `commands.ts launchShip`/`landShip`, `sim.ts arriveLaunch`/`arriveLand`): `launchShip`/`landShip`
  no longer teleport surface↔parking-orbit — the powered ascent/descent flies in-sim as a read-time
  spline sampled from the gravity-turn budget integrator (`surface.ts` now emits a `[t,h,v,γ,θ]`
  trajectory; the airless descent is the ascent reversed), reconstructed with the same
  `planeBasis`/`reconstructEntry` geometry as the entry leg and rendered for free via
  `shipForecastPath`. Δv charged at commit; a `launch-arrive`/`land-arrive` finalize seats the ship
  on the pinned parking orbit / co-rotating touchdown. Atmospheric descents still use the ballistic
  `EntryLeg`. Optional ⇒ golden hash unmoved; stored spline + scheduled finalize ⇒ chunk-invariant
  (`app/launchLeg.test.ts`). Still to do: radiative (shock-layer) heating above
  ~11 km/s; atmospheric co-rotation / lift in the in-sim pass (planar ballistic first cut);
  and a B-plane-targeted aim (the arrival uses a patched-conic periapsis aim today).
- **More bodies** — DONE: 43 bodies (dwarfs, asteroids, gas-giant & other moons,
  plus TNOs and comets) on the fixed-J2000-conic (`FixedHelioRow`) + `MoonRow`
  paths, Horizons-checked. Still to do: irregular-moon precession, more small
  bodies, comet outgassing/non-gravitational forces.
- **Interstellar sky / camera** (presentation) — DONE: two views split the
  unbridgeable scale gap (a 1-AU planet and a 4-ly star differ ~1e6× in distance,
  so no single frame frames both). The **in-system** view paints the real nearby
  stars on an *unzoomable camera-locked sky* in their true Sun→star direction —
  a directionally-honest backdrop that can't crowd the planets or parallax against
  the orrery (replaces the old compressed shell just past Neptune). The **interstellar**
  view (`render/interstellarView.ts`, toggled with the HUD switch / `M`) drops the
  orrery and places the ~24 systems at their *real relative distances* — to-scale is
  easy here because the range is only 4–12 ly (~3×), nothing like the in-system gap —
  with Sol at the origin, proper-motion drift, and any ship (or object) on an
  interstellar leg drawn at its true position along the way. Still to do: click-to-focus
  a star in the interstellar view; reconcile the in-system ship in-transit streak (still
  on the legacy compressed shell) into the interstellar view; an optional faint deep-sky
  backdrop sourced from a **real** catalog (e.g. Hipparcos/Gaia bright stars) — explicitly
  *not* a re-introduced procedural/fake starfield.
- **Stellar proper motion** — DONE: the nearby-star catalog carries real Gaia /
  Hipparcos proper motion (μα\*, μδ in mas/yr) and radial velocity (km/s); each star
  derives an ecliptic-J2000 **space-velocity vector** at load and drifts linearly with
  time (`starState(star, t)` / `starPosition(star, t)` — exact straight-line inertial
  motion, read-time analytic, golden-hash-neutral since the catalog is static module
  data). Interstellar legs **lead the target** — they aim at the star's *arrival-time*
  position (a fixed brachistochrone line, recomputed deterministically from
  `targetStar` + `tArrive`, so no new serialized state), and `dispatchInterstellar`
  re-solves the flip-and-burn against that lead-aim distance for a consistent
  `(a, D, T)`. The star map renders the drift. Still to do: per-component binary
  *orbital* motion (only the system's bulk space motion is modelled today — a
  documented approximation, like the Pluto–Charon barycentre).
- Minor fidelity: EMB-vs-Earth-centre ~4671 km offset; Moon & small-body two-body
  precession drift over years; the Pluto–Charon barycentre approximation.

## Consciously-deferred audit notes (non-blocking, already judged)

- comms: control node treated as fixed during light-travel (O(v/c), ~0.13 s at
  Earth–Mars max range).
- comms: a command's light-arrival time is solved once at emission and not
  re-solved if the ship's path is later mutated in flight (a second delivered
  burn, or an SOI patch). The firing-instant drift is O(δr/c) — sub-millisecond
  at in-system speeds — and the burn still executes against the ship's real live
  state, so only the timing (not the physics or Δv) is slightly stale.
- `arrival.ts`: aim bisection returns the smallest achievable periapsis if the
  requested one is below reachable (a safe over-shoot).
- Equal-time event tie-break is insertion order (deterministic for current
  schedulers; revisit if simultaneous cross-ship events become common).
