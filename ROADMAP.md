# LIGHTLAG — roadmap

**Status:** Phases 1–6 complete; core-physics hardening pass complete (ephemeris
tightening + Horizons cross-check, integration-invariant suite, golden-state
determinism, and an adversarial cross-subsystem audit with its confirmed findings
fixed). The reusable physics engine is the `@lightlag/engine` workspace package
(`packages/engine/`; see [ARCHITECTURE.md](ARCHITECTURE.md)); 758 passing
physics/sim tests — including a
JPL Horizons ephemeris cross-check, cross-subsystem conservation/SOI-continuity
(entry **and** egress) invariants, off-nominal flyby + abort handling, and a
golden-state determinism hash.

Built so far: real ephemeris + Keplerian orbits, the rocket equation + staging +
RK4 powered flight, transfer planning (Lambert / Hohmann / porkchop / real launch
windows), patched-conic SOI capture, light-lag command (the thesis), and
thermal / power / detection ("no stealth in space"). Plus parallel-session
add-ons: a 30-craft preset catalog and keyboard controls.

**Core-mechanics expansion (latest):** the full Solar System — 130 bodies total:
the 8 planets, the dwarf planets and large TNOs, a deep moon roster (the
Galileans + Jupiter's inner Amalthea group & classical irregulars; Titan + the
major Saturnians + ring-shepherds, co-orbitals, Hyperion & Phoebe; the major
Uranians + Puck-group inner moons & irregular Caliban/Sycorax; Triton + Neptune's
inner regulars & Nereid; Phobos/Deimos; the Pluto system — Charon + the four small
moons Styx/Nix/Kerberos/Hydra that circle the Pluto–Charon barycentre), the small-body populations
(main belt, near-Earth asteroids, Jupiter Trojans, Kuiper belt, an 8-strong
scattered disc and a 6-strong inner Oort cloud of detached sednoids), twelve
comets (spacecraft targets 67P/9P/81P/103P/19P, shower parents 55P/109P/21P,
the great comets 12P/Pons–Brooks & Hale–Bopp, plus 1P/Halley & 2P/Encke) and the major man-made
satellites (ISS, Hubble, Tiangong — a new `satellite` body class), each on a
JPL-validated J2000 osculating ephemeris;
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
- **Propellant depots + refueling — DONE (first cut):** rendezvous-gated ship-to-ship
  propellant transfer + in-orbit assembly (`packages/engine/src/refuel.ts`); docking raises m₀ → Δv,
  mass-conserving and capacity-capped. Still to do here: persistent depot *stations*
  (transfer is ship↔ship today), propellant boil-off, and a rendezvous-targeting planner
  (you fly craft co-orbital by hand; identical orbits dock exactly).
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

*(Most recent: **Δv-accounted station-keeping — holding a point is no longer free.** Building on the
perturbed tier, a ship can now `holdStation` an L-point or a high orbit: it spends correction Δv
each window to cancel the third-body drift and **drifts off once it can't afford it** (the "not for
free" consequence — e.g. a sim must ensure a craft has the propulsion to maintain L2). `Ship.stationKeep`
+ `Simulation.holdStation`/`releaseStation`; charged impulsively at the leg finalize ⇒ chunk-invariant
and golden-hash-neutral; surfaced in the flight-console FIDELITY block (target, Δv spent, ≈Δv/yr).
Validated: a held GEO orbit holds its inclination for ~hundreds of m/s/yr while an unheld one drifts;
a held Sun–Earth L2 craft stays on-point where an unheld one wanders ~1900 Mm in 40 days. The free
catalog-satellite `stationKept` model is unchanged. See the "Player-ship station-keeping" backlog
entry. The round before: **higher-fidelity propagation — the explicit fidelity-mode framework + third-body
perturbed arcs** (the single biggest realism gap, from `docs/physics-assessment.md` §B-1). Three
named tiers — **game** (default, untouched), **perturbed** (a ship flown under continuous
third-body gravity via `Ship.fidelity` + a `PerturbedLeg`), and **high-fidelity planning** (the
read-time `perturbedForecast` preview) — built on a shared "one gravity law" term library
(`perturbations.ts`) and a deterministic perturbed integrator (`perturbed.ts`). Opt-in ⇒ golden
hash unmoved; preview is pure read-time; the flown leg is chunk-invariant. Validated against the
textbook GEO lunisolar inclination drift (~0.85–0.95°/yr) and the Sun–Earth L2 instability — a
craft at L2 now actually drifts off the kinematic point, closing the PR-#80 Lagrange gap. A magenta
"Perturbed" overlay + a FIDELITY console toggle surface it. See the backlog entry and the "Done
since last round" note. The round before, **click-to-focus extended to the in-system orrery** landed.)*

1. **ISRU / depots (Phase 7)** — mass economy. Propellant transfer + in-orbit assembly are now
   DONE (a first cut — `packages/engine/src/refuel.ts`); what remains is ISRU from moon/comet/regolith volatiles,
   persistent depot stations, propellant boil-off, and a colony supplied within a transfer window.
   *(see Phase 7.)*
2. **Interstellar follow polish — eased transition + reconcile the in-system streak** — the
   interstellar camera now follows a ship *or* a focused star, but it re-homes in a single frame
   (the documented "interstellar re-homes instantly" semantics); a smooth eased transition into the
   focus is the natural next step. Paired with it: reconcile the in-system ship in-transit streak
   (still drawn on the legacy compressed shell just past Neptune) into this view, and an optional
   faint deep-sky backdrop sourced from a **real** catalog (Hipparcos/Gaia bright stars) — explicitly
   *not* a re-introduced procedural starfield. *(From the "Interstellar sky / camera" backlog.)*

*(**Animated launch / landing trajectories** — candidate #3 two rounds ago — is now DONE; see the
"Done since last round" note below.)*

*(Done since last round: **Click-to-focus extended to the in-system orrery**. The interstellar map
gained a star-pick last round; this brings the same affordance to the system view — click any body
(planet, moon, dwarf, asteroid, comet, satellite, or the Sun) to frame it, instead of only the
nav-list buttons / keyboard (1–8, Tab). The pure screen-space selector `pickNearest` moved from the
interstellar view to the shared `render/overlayUtil.ts` so both picks import it without coupling. A
tap-vs-drag pointer handler on the canvas (`ui/hud.ts`, gated to the system view; an OrbitControls
drag of more than a few px never selects, and a tap on empty space is a no-op) projects every
on-screen, *visible* body via `BodyViews.labelAnchors()` — reusing the exact NDC anchors and the
`vis.bodyVisible` filter the label layer already uses — and routes the nearest hit through the
existing `hud.focus(id)` → `SceneManager.focusBody` animated fly-to (which already frames every kind)
plus the nav-list active-button sync, so a click behaves identically to a list/keyboard focus.
**Render/UI only — nothing reaches `WorldState`, so the golden hash is unmoved (`11f2c9fc7a5876`).**
The 6 pure `pickNearest` specs moved with it into `render/overlayUtil.test.ts` (suite still 733
green); the canvas projection / pointer handling / fly-to need a WebGL+DOM context, so they are
verified manually, as the interstellar pick and the rest of the camera code are. **Cluster
disambiguation (follow-up):** in a tight overlapping group the pick now favours the most *prominent*
body by kind — the shared `pickNearest` takes an optional per-marker `priority`, and the body pick
passes the same `LABEL_PRIORITY` rank the label de-collision uses (planet over satellite), breaking
ties by distance — so an LEO satellite no longer steals a click meant for Earth; selecting a
less-prominent body in a tight cluster just needs a zoom-in (the star pick, which passes no priority,
is unchanged). Still to do: a hover highlight before clicking.)*

*(Done since last round: **Click-to-focus a star in the interstellar view**. Last round taught the
interstellar camera to lock onto a ship in transit, but a STAR could not be selected — there was no
way to frame a specific system or read its facts, even though the focus plumbing
(`SceneManager.setInterstellarFocus` / `followInterstellar`) was generic and the selection field could
already hold any id. This round lets you pick a star two ways and frames it through that very plumbing.
**(1) Click a star marker.** A new `pointerdown`/`pointerup` tap handler on the shared canvas
(`render/interstellarView.ts`) acts only on the interstellar map and only on a *tap* — a press that
travels more than `DRAG_PX` between down and up was an OrbitControls orbit/zoom and is ignored, so the
two pointer consumers never fight. A tap runs `pickStar`, which projects Sol + every star marker to
screen pixels with the EXACT `placeLabel` projection and returns the nearest within `PICK_PX` via a
pure, unit-tested `pickNearest` (a screen-space nearest-marker test deliberately replaces a
`THREE.Raycaster`, which is unreliable against these `sizeAttenuation:false` screen-fixed sprites);
the hit's id flows to `setInterstellarFocus`, with Sol's entry carrying `id:null` so clicking Sol
recentres. Clicking empty space is a no-op (no accidental deselect — matching the ship-follow
semantics). **(2) Pick from a HUD STARS list.** A new nav-dock **STARS** section (`ui/hud.ts`, shown
only on the interstellar map, the FOLLOW-section pattern) lists the navigable systems nearest-first
from a new pure `interstellarStarList()` read-only query (`app/commands.ts`, the
`interstellarFleet`/`dockCandidates` shape); each button frames its system through the same `setFollow`
→ `setInterstellarFocus` path a marker-click uses. **Framing + readout.** `InterstellarView.updateFocus`
gained a star branch ahead of the ship branch: a focused star (resolved via `STAR_BY_ID`) is framed by
the SAME `followInterstellar` shift-both trick (look-at and camera move together, so the user's zoom
and orbit offset are preserved) and tracks the star's slow proper-motion drift; it never self-heals
(a star can't be deleted), while a ship follow still drops back to Sol when its leg ends. The nav-dock
footer doubles as a star readout (`showStarReadout`): live distance (it drifts under real proper
motion), light-time from Sol, spectral type, luminosity, mass, and constellation. The focused star
marker reads a touch larger (parity with the followed-ship marker). The selection field stays a single
id: ship ids are `ship-N` and star ids are catalog slugs (`proxima`, …), disjoint id-spaces resolved
by lookup, so no tagged union and no public-API churn (`R`, the Sol button, and a Sol click all clear
via the existing `setInterstellarFocus(null)`). **The whole feature is render/UI — nothing reaches
`WorldState`, so the golden hash is unmoved (`11f2c9fc7a5876`).** +9 tests
(`render/interstellarView.test.ts`: the pure `pickNearest` — nearest within threshold, inclusive at
the threshold, deterministic tie-break by array order, empty list, and a preserved `null` Sol
sentinel; `app/interstellarFollow.test.ts`: `interstellarStarList` field shape, nearest-first order,
and a deterministic list including a known nearby system); the camera framing, the world→screen
projection, the pointer pick, and the readout need a WebGL+DOM context, so they are verified manually,
as the ship follow-cam is. Still to do: a smooth eased transition into the focus (it re-homes in one
frame today — now candidate #2); picking a specific binary component when its marker overlaps the
primary (the STARS list exposes them, but the marker-pick takes whichever projects nearest); and
reconciling the in-system in-transit streak into this view. *(Candidate #2.)*)*

*(Done since last round: **Follow ships in the interstellar view — the camera no longer hard-locks on
Sol**. Entering the interstellar map used to pin `controls.target` to the origin
(`SceneManager.frameInterstellar`) with no way to follow a ship streaking out to a star — you could
watch it crawl across the map but never centre on it. Now the interstellar camera can lock onto a craft
in transit and track it across the years. Because the interstellar view draws into its OWN root group
in absolute render-space (Sol at the origin, heliocentric metres ÷ `INTERSTELLAR_M_PER_UNIT`) and never
consults the in-system floating origin, the follow does NOT go through `setFocusTarget` (the
floating-origin path): a new `SceneManager.interstellarFocus` selection + `followInterstellar(pos)`
drives `controls.target` directly, shifting the look-at AND the camera by the same per-frame delta — the
identical shift-both trick `advanceFlight`/`cancelFlight` already use, so the user's orbit offset and
zoom are preserved and `|camera − target|` (the min/max-distance clamp) stays invariant; the first
follow frame recentres the ship to where Sol sat and later frames track it as the starfield drifts past.
The interstellar view owns the geometry: a per-frame `updateFocus()` hook reads `sm.interstellarFocusId`,
computes the followed ship's scaled position with the SAME `toUnits(shipWorldState(ship,t).r)` it already
draws the marker at, and calls `followInterstellar`; it runs ungated by the ships layer (you can follow a
ship whose marker is hidden) and self-heals — a deleted / off-leg follow drops back to Sol
(`setInterstellarFocus(null)` → `frameInterstellar`), which also clears the HUD selection. The followed
marker reads a touch larger. Ship selection is surfaced as a HUD **FOLLOW** section in the nav-dock,
shown only on the interstellar map (where the body list is inert): a Sol button (recentre) plus one per
ship in transit, sourced from a new pure `interstellarFleet(world)` query (`app/commands.ts`, the
`dockCandidates` read-only-query pattern — ships on a leg, not lost, sorted by name) and rebuilt only when
the in-transit id-set changes. Dispatch pre-arms the focus (`InterstellarPanel.dispatch` →
`setInterstellarFocus`) so pressing `M` immediately follows the just-launched ship; `R` (resetView) in the
interstellar view recentres Sol and clears the follow. **The whole feature is render/UI — nothing reaches
`WorldState`, so the golden hash is unmoved (`11f2c9fc7a5876`).** +6 tests
(`app/interstellarFollow.test.ts`: `interstellarFleet` empty / lists a dispatched ship by id+name /
excludes off-leg ships / drops a lost ship / deterministic name order / read-only hash-neutral); the
camera math needs a WebGL context (the `SceneManager` constructor builds a `WebGLRenderer`) so it is
verified manually, as the render layer's other camera code is. Still to do: a smooth eased transition into
the follow (it re-homes in one frame, matching the documented "interstellar re-homes instantly"
semantics); click-to-focus a STAR in the interstellar view reusing the same plumbing (now candidate #2);
and reconciling the in-system in-transit streak into this view. *(Candidate #1; Observation #2.)*)*

*(Done since last round: **Parent-centric porkchop + eccentric capture everywhere**. A single moon
hop used to call `searchMoonWindow` once and pick one coarse window — no porkchop, always a low
circular capture — while the moon flyby TOUR already searched a parent-centric grid AND could
capture into the Oberth-cheap loose ellipse. This brings the single hop to parity. New pure
`computeMoonPorkchop` (`packages/engine/src/maneuver/moon.ts`) is the intra-system twin of `computePorkchop`,
returning the SAME `Porkchop` shape so the planner's canvas/crosshair/`selectBest` render it
unchanged: departure axis = one moon period, TOF axis = the Hohmann band, and — because a parking
orbit is fast (a LEO is ~90 min) next to the moon geometry (~27 days), so the cheap in-plane
injection lives only at a narrow, fast-recurring departure node — each cell scans the parking-orbit
phase within its column and keeps the cheapest injection, storing the REFINED departure instant that
achieved it (the same anti-aliasing `searchMoonWindow` does, now presented as a grid). Cells use the
cheap centre-aimed Lambert; `planMoonTransfer` does the exact J2-aware `aimMoonArrival` at commit —
the same porkchop-estimate / real-plan split the heliocentric planner uses. `captureApoAlt` now
threads through `searchMoonWindow` (a `captureDv` closure: `ellipticalCaptureDv` when set, else
`hyperbolicBurnDv`) and through the cross-system auto-chain `maybeChainMoonLeg` (`sim.ts`): when the
Stage-1 planet capture was elliptical, the chained moon leg captures loose too — but sized to the
MOON's own well via a new core `moonLooseApoAlt` (= half the moon's SOI above its surface; reusing
the vast Jupiter apoapsis altitude would be physically wrong), not the planet's. The planner's
moon-direct path now shows the porkchop + a CAPTURE MODE control (circular vs loose ellipse;
aerocapture stays heliocentric/tour-only); commit flies the selected cell with the chosen capture.
All new state is optional and the golden scenario has no moon mission / `captureApoAlt`, so the
**golden hash is unmoved** (`11f2c9fc7a5876`). +13 tests (`packages/engine/src/maneuver/moonPorkchop.test.ts`:
grid shape + finite best, loose-ellipse-cheaper, determinism, null guard, `moonLooseApoAlt`
magnitude, `searchMoonWindow` elliptical < circular; `app/moonTransfer.test.ts`: `planMoonTransfer`
with an apoapsis captures cheaper and flies a bound ellipse; `app/moonMission.test.ts`: an elliptical
Stage-1 mission auto-chains a loose Europa leg sized to Europa, a circular one stays circular). Still
to do: a parent-centric chain/flyby porkchop (the tour search is still a bounded grid, not an
exhaustive sweep), and the exact J2 aim in the grid cells (the cells use the cheap Lambert; commit
re-aims). *(Candidate #1.)*)*

*(Done since last round: **J2 on the planetary approach — the honest single-pass version**. The
heliocentric→planet capture hyperbola (`aimArrival`) was pure two-body even at an oblate giant.
Secular J2 (`orbit.ts j2Rates`) is the orbit-averaged drift of a BOUND orbit and is identically zero
on a hyperbola, so "parity with the J2-aware moon aim" was a category error — `aimMoonArrival`'s J2
acts on a BOUND parent-centric ellipse, while a direct planet arrival is a single hyperbolic pass with
no bound phase. The real effect is the NON-secular perturbation integrated along the open arc: at an
oblate giant the periapsis a capture actually reaches differs from the two-body `a(1−e)` by hundreds of
km, with sign/size set by the approach's inclination to the equator (it passes through zero near the
~55° critical inclination). New pure `packages/engine/src/maneuver/approach.ts` integrates the inbound hyperbola under
point-mass + the J2 zonal term referenced to the body's spin pole (`ships.ts spinAxis`, RK4 with a
state-adaptive step, periapsis refined by bisection on r·v=0) — deterministic in the SOI-entry state, so
chunk-invariant when stored once and replayed. It is carried as an `ApproachLeg` (`world.ts`, the
`LaunchLeg`/`EntryLeg` read-time-leg pattern): a 3D arc spline + the pinned periapsis the capture fires
at (`ships.ts buildApproachLeg`/`approachLegState`; `shipRelativeState`/`shipOsculatingElements` dispatch
through it; serialized). The flight (`sim.ts enterSoi`→`captureAtPeriapsis`) flies the leg for an inbound
hyperbola at any oblate body and captures at the perturbed periapsis; the aim (`maneuver/arrival.ts
aimArrival`) evaluates its offset bisection by integrating the SAME `j2Approach`, so the planned
periapsis equals the flown one (the aim-must-match-flight rule — wiring the flight alone flew a low
Jupiter capture sub-surface and crashed the moon-mission ship). A Saturn capture lands at the aimed
altitude despite the ~hundreds-of-km shift; a spherical body returns null and stays the pure-Kepler coast.
Impulsive + read-time-leg + scheduled-event ⇒ chunk-invariant (one-step ≡ chunked still holds). **Golden
hash re-baselined** (`0058e70b45c3ef` → `11f2c9fc7a5876`): the Mars arrival now carries the J2 periapsis
shift (O(km) at Mars); only the recorded physical value moved (round-trip + negative control unchanged),
and no giant-capture assertion needed re-tuning. +8 tests (`packages/engine/src/maneuver/approach.test.ts`: oracle
[J2=0 recovers two-body to <1 m], magnitude/sign vs inclination, determinism, arc interpolation, leg
build/read, serialize; `app/j2Approach.test.ts`: the leg flies and the capture lands where aimed,
chunk-invariance, mid-approach serialize). Still to do: the J2 perturbation on an AEROCAPTURE approach
(above-atmosphere arc to the interface — the drag-pass entry leg is unchanged today); J3+ zonal harmonics;
and full N-body. *(Candidate #1.)*)*

*(Done since last round: **B-plane-targeted in-sim flyby pass — the geometry made explicit and
inspectable**. The in-sim flyby (`sim.ts executeFlyby`) flew a "patched-conic point + charged residual"
but never computed or surfaced the actual B-plane geometry of the pass, though the analytic helpers
(`flyby.ts bPlaneAim` / `impactParameter`) already existed unused by the executor. Each `FlybyLeg` now
records, at execution, the geometry it actually flew — the rpMin-clamped periapsis (`rpAchieved`), its
impact parameter b = rp·√((e+1)/(e−1)) (`bMag`, the B-plane targeting handle), the required bend
(`turn`), and any turn the free pass couldn't supply (`residualTurn`; 0 ⇒ free). All four fields are
OPTIONAL and serialize only once a pass is flown, so a planned-but-unflown chain — and the golden
scenario, which has no flyby — round-trips byte-for-byte: the connecting velocity v1 and the charged
residual (`flybyManeuver`, already B-plane-consistent) are unchanged, so the flown trajectory and cost
are byte-identical and the **golden hash is unmoved** (`0058e70b45c3ef`). `minFlybyRadius` is now
atmosphere-aware — `max(1.1·radius, radius + entryInterfaceAlt)` so a clean vacuum slingshot never dips
inside a modeled atmosphere; a verified no-op for every body modeled today (the 10% margin already
clears the 11-scale-height interface), it keeps the "closest SAFE pass" contract honest and guards a
future thick-atmosphere small body. The HUD surfaces the geometry in BOTH the flight console (the flown
pass: periapsis altitude, b in body radii, turn, free/burn) and the transfer planner (the single-flyby
and chain readouts now show b alongside the periapsis and turn they already displayed — partially
closing "Full B-plane targeting in the planner UI"). +8 tests (`app/bplaneFlyby.test.ts`:
recorded-geometry sanity in the heliocentric AND parent-frame moon-tour branches, chunk-invariance,
serialize round-trip, and the golden-neutral ABSENCE of the fields on an unflown chain; plus
`flybyAssist.test.ts` checks that `bPlaneAim.rp ≡ flybyManeuver.rp` for a free pass and that the safe
radius clears every modeled atmosphere). Verified live in both themes (Earth→Jupiter→Saturn: flight
console "peri 668161 km · b 32.7 R · turn 108° · burn 8 m/s"; planner "peri 2741307 km, b 71.1 R, turn
65°"). *(Candidate #1's B-plane half. Still to do: the connecting velocity is still assigned to thread
the chain rather than re-derived from a pure B-plane integration, and the pass is instantaneous at
heliocentric scale — an animated finite-SOI flyby arc, like the launch/entry legs, is a separate
follow-up that would move pass timing and re-tune the chain tests.)* **The J2-on-the-approach half was
deliberately deferred to its own round** — secular J2 is identically zero on a hyperbola, so "parity
with the J2-aware `aimMoonArrival`" (whose J2 acts on a BOUND ellipse) is a category error; the honest
single-pass J2-perturbed `ApproachLeg` (which MOVES the golden hash and re-tunes the giant-capture
tests) is now candidate #1.)*

*(Done since last round: **launch vehicles fly the ascent to LEO** — closing the "everything spawns
full in LEO" hole. A preset's `role` now drives WHERE it starts: a launch vehicle (`spawnOnPad`)
stands on the Earth pad and flies the gravity-turn ascent (the existing `launchShip`, now with an
`opts.instant` express path `expressToOrbit`), so its boost/lower stages are EXPENDED in the climb
(via the rocket equation across stages) and only the surviving payload + orbital stage reaches LEO;
an in-space craft still deploys directly in LEO with full propellant (so the default/custom designs —
and the golden scenario — are unchanged, hash unmoved). `shipSurfaceParams` is now booster-aware
(`stageLiftoffThrust` + new `stageLiftoffExhaust` for the thrust-weighted liftoff vₑ_eff) — without
it a strap-on launcher (Shuttle/Soyuz/Falcon Heavy/Ariane) read T/W < 1 and couldn't lift off. The
designer gained a "launch vehicle" toggle, role-aware launch controls, and a live ascent-budget /
orbital-survivor readout that gates launch. Catalog: first-stage Isp corrected to TRAJECTORY-AVERAGED
(pure sea-level understated total impulse and left real launchers below orbit), and a few
representative payloads set so all 11 launch vehicles reach their historical LEO with honest margins
(Saturn V keeps ~3 km/s of TLI; the R-7/Titan/Saturn-IB arrive at the ragged edge, as the real
vehicles did). +7 tests (`app/launchAscent.test.ts`): per-preset LEO feasibility + survivor sanity,
flown-ascent ≡ express, pad placement, in-space-unchanged, and an infeasible-design guard. Falcon
Heavy's headline 63.8 t assumes crossfeed (still a backlog item) so it's modeled at a no-crossfeed
~45 t. Earlier: **orbital propellant transfer + in-orbit construction** (Phase-7 first cut) —
the SpaceX-tanker / depot mechanic and dock-merge assembly, both gated on a TRUE RENDEZVOUS (shared
primary + co-located in position and matched in velocity; co-orbital craft pass exactly). A new pure
`packages/engine/src/refuel.ts` adds the rendezvous gate (`dockState`/`isDockable`), a mass-conserving,
capacity-capped propellant move (`transferProp` — drains donor core stages, fills receiver stages to
their as-built `stageCapacity`), and `mergeStacks` (the added ship's remaining stages stack atop the
base's and its payload sums in — in-orbit construction). `Stage.propCapacity` (optional, set at spawn
= the design's full load) records the tank ceiling so a ship can be topped back up but never
over-filled; it serializes only when tracked. `app/commands.ts` wraps these as `dockCandidates`,
`transferPropellant`, `assembleShips`, `shipPropStatus`, and the flight console gains a **DOCK /
TRANSFER** section (partner list, prop/headroom readouts, Receive/Send, Assemble). Instantaneous
local-SOI ops (like land/launch/spiral — not light-lag-routed). +13 tests (`app/refuel.test.ts`):
capacity, the rendezvous gate, mass conservation, over-fill / overdraw caps, assembly mass+Δv,
serialize round-trip. **Golden hash re-baselined** (`03539f9fb1ffcd` → `0058e70b45c3ef`): spawned
ships now carry `propCapacity` — determinism is otherwise unchanged (chunk-invariance, round-trip,
and the negative control all still pass; only the recorded value moved). Still to do: persistent
depot *stations* (ship↔ship today), boil-off, a rendezvous-targeting planner, and a B-plane/relative
proximity-ops nav aid.)*

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

- **Satellite drag fidelity (rung 2)** — **Rung 1 DONE:** the engine has a closed-form
  secular drag — the TLE's measured ṅ carried onto `Ship.drag` and applied in
  `coastElements` as `M += ½·ṅ·dt²` along-track plus the consistent SMA decay
  (`n²a³ = μ`). Constant rate ⇒ exact at any time-warp, no integration; captures the
  dominant along-track drift. **Ingested satellites are now `stationKept` (DONE)** so
  the decay is *suppressed* for them — a constant near-epoch rate extrapolated forever
  otherwise spirals every positive-ṅ object into the planet (and balloons every
  negative-ṅ fit outward), which is wrong for *maintained* craft; the recorded ṅ is kept
  as the natural decay (input to station-keeping Δv, below). The un-kept model still runs
  for objects that genuinely decay. What rung 1 can't do for those: a *constant* rate
  misses the decay **runaway** as perigee drops, and has no handle for space-weather.
  **Rung 2 (future):** replace the constant ṅ with an altitude- and activity-driven rate
  — a King-Hele averaged-element decay from an exponential / Harris-Priester atmosphere
  `ρ(a)`, scaled by the object's ballistic coefficient (recoverable from the TLE's `B*`)
  and modulated by solar flux (F10.7) and the geomagnetic index. Cost: a cheap per-orbit
  integration (crosses the engine's "no-integration / closed-form" line, so gate it to
  drag-flagged ships). Pairs with a *live-present* TLE re-poll (re-anchor `elements`+
  `epoch` and refresh `B*`/F10.7 when the sim clock tracks now); re-polling does nothing
  under time-warp, where the propagation model is all you have. The honest alternative
  for max fidelity is to keep the `SatRec` and propagate satellites through SGP4 itself
  (app-layer, not engine ships) — collapses drift to the irreducible SGP4-vs-reality
  floor at the cost of serialize/replay determinism for those objects.
- **Player-ship station-keeping (Δv-accounted)** — **DONE (first cut), driven by
  third-body drift.** `Ship.stationKept` remains the FREE, implicit-burn model for catalog
  satellites (`coastElements` suppresses drag decay; no propellant tracked). The PLAYER
  paid model now exists as `Ship.stationKeep` + `Simulation.holdStation`/`releaseStation`
  (`sim.ts`): a ship actively spends Δv each correction window to hold a nominal target
  against the third-body drift the perturbed model reveals, and **drifts off once it can
  no longer afford the hold** (`holding=false` → the uncontrolled perturbed leg takes over
  → possible reentry via the existing `impactTime`/`crashShip` path). It runs ON TOP of the
  perturbed leg: each window is a short `PerturbedLeg` that drifts off, then a correction
  Δv (a velocity-restore to the nominal, the deadband generalization of `arriveAtLagrange`'s
  velocity match) is charged via `applyImpulsiveDv` and the ship re-seated on the nominal.
  Two target kinds: an **L-point** (nominal from `lagrangeState`) and a **high orbit**
  (nominal = the arrived orbit, advanced by Kepler + secular J2). The flight console's
  FIDELITY block surfaces the hold target, Δv spent, and the projected Δv/yr; charged
  impulsively at the finalize event so it stays chunk-invariant and (opt-in ⇒) golden-hash
  neutral. Validated: a held GEO orbit holds its inclination for ~tens-to-hundreds of m/s/yr
  while an unheld one drifts; a held Sun–Earth L2 craft stays on-point where an unheld one
  wanders ~1900 Mm in 40 days; a small-tank craft runs out and drifts off. **Still to do:**
  this is driven by third-body drift, not yet by *atmospheric drag* — wiring it to
  `drag.nDot` (sized from the orbit's natural decay) once player orbits are drag-flagged
  (rung-2) is the remaining half; plus a position-correction term (the deadband re-seats the
  small position drift for free today) and an auto-engage option.
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
  ET; Falcon Heavy's headline 63.8 t LEO assumes it, so it's modeled at a
  no-crossfeed ~45 t). (Boostered first stages now DO fly the ascent from the pad —
  see "launch vehicles fly the ascent to LEO" above.)
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
  chunk-invariant. **B-plane geometry made explicit — DONE:** the in-sim pass now computes and records
  the real B-plane geometry it flies (`FlybyLeg.rpAchieved`/`bMag`/`turn`/`residualTurn` via `bPlaneAim`
  + `impactParameter`), surfaced in the flight console and the planner; `minFlybyRadius` is atmosphere-
  aware. The connecting velocity and charged residual are unchanged (golden hash unmoved). Still to do:
  the connecting velocity is still assigned to thread the chain rather than re-derived from a pure
  B-plane integration, and the pass is instantaneous at heliocentric scale — an animated finite-SOI
  flyby arc (the launch/entry-leg pattern, but it moves pass timing and re-tunes the chain tests) is a
  follow-up; plus a full chain porkchop (the UI searches TOF multipliers around Hohmann timings, not an
  exhaustive window sweep); and deeper multi-flyby resonant tour optimization (the tour search is a
  first-cut bounded grid capped at ≤3 flyby moons over a curated sibling set).
- **Transfer toolkit** — DONE: plane-change Δv, bi-elliptic transfers, and
  multi-revolution Lambert (wired into the porkchop).
- **J2 oblateness** — DONE: secular nodal/apsidal precession of ship/station
  orbits about oblate bodies (orbit.ts j2Rates), applied analytically at read time
  (exact at any time-warp; golden-hash-neutral), with a sun-synchronous-inclination
  helper. The **moon-arrival aim is now J2-aware** (`aimMoonArrival` propagates the
  parent-centric cruise with the parent's J2, matching `coastElements` — a gas giant's
  oblateness no longer drifts the short hop out of a moon's small SOI). **The heliocentric→planet
  capture approach is now J2-aware too — DONE:** the inbound hyperbola is no longer pure two-body at an
  oblate body. Because secular J2 (`j2Rates`) is identically zero on a hyperbola, this is NOT the moon
  aim's secular machinery but a single-pass J2 PERTURBATION integrated along the open arc
  (`maneuver/approach.ts`, referenced to the body's spin pole), flown as a deterministic `ApproachLeg`
  and aimed by the same integrator so aim ≡ flight (periapsis moves hundreds of km at a giant; golden
  re-baselined for the O(km) Mars shift). Still to do: full N-body perturbations, J3+ harmonics, and the
  J2 perturbation on an AEROCAPTURE approach (the above-atmosphere arc to the interface — the drag-pass
  entry leg is unchanged today).
- **Higher-fidelity propagation — explicit fidelity modes + third-body/perturbed arcs**
  — **DONE (first cut):** the single biggest realism gap is closed as an opt-in,
  preview-first capability that leaves the default game byte-identical (golden hash
  unmoved). Three pieces shipped:
  - **Fidelity is now a first-class, explicit choice.** Three named tiers:
    **game/default** (today's deterministic patched-conic + secular-J2 model — the
    absence of any flag) · **perturbed** (a ship FLOWN under central + selected
    third-body + optional numerical J2, opt-in via `Ship.fidelity`) · **high-fidelity
    planning** (the read-time perturbed *forecast*, a `Simulation.planningFidelity`
    preview/analysis toggle that never touches `WorldState`).
  - **Third-body / perturbed propagation** — a shared acceleration-term library
    (`packages/engine/src/perturbations.ts`: `centralAccel` / `j2ZonalAccel` /
    `thirdBodyAccel`, reused by the force overlay AND the integrators — "one gravity
    law"), a deterministic fixed-/adaptive-step RK4 perturbed integrator
    (`packages/engine/src/perturbed.ts`, cloned from `approach.ts` with a TIME-DEPENDENT
    acceleration that reads each perturber from the analytic ephemeris at `t0+τ`, so it
    stays re-derivable), a read-time `perturbedForecast` (`trajectory.ts`) with a
    divergence-from-the-two-body-coast readout, and a FLOWN `PerturbedLeg` (`world.ts`,
    the ApproachLeg read-time-leg pattern) the sim coasts as successive bounded chunks,
    SOI-clamped and re-osculating at each finalize. Validated against textbook numbers:
    GEO lunisolar inclination drift ≈ 0.85–0.95°/yr and the Sun–Earth L2 instability
    (a craft at L2 now actually drifts off the kinematic point under Earth's pull —
    closing the PR-#80 Lagrange gap, where L-points were kinematic-only). Opt-in ⇒
    golden hash unmoved; preview is pure read-time; the flown leg is chunk-invariant.
    Still to do: in-perturbed-arc surface-impact (today gated to high/bound orbits),
    third-body terms inside a powered BURN, and an eased preview cadence.
  - **Integrated (flown) low-thrust arcs** — STILL TO DO: reuse the existing RK4 powered
    integrator for an in-sim electric spiral (the analytic Edelbaum leg lands first
    today; "in-sim flyable capture/escape spiral" is already listed under "Power-limited
    electric thrust"). Bounded effort, good payoff for electric craft.
  The next framework payoffs (now cheap, additive *terms* / a *mode hook*): J3/J4 zonals
  in `perturbations.ts`; the high-fidelity-planning ephemeris hook (the deferred Standish
  long-period terms / optional sampled import). All preserve the engine's invariants
  (fixed grid, exact event splitting, deterministic ordering, stable serialization,
  documented golden hash — see `docs/error-budget.md` and `docs/deliberate-omissions.md`).
- **Full B-plane targeting in the planner UI** — the analytic aim (`bPlaneAim`:
  free-bend hyperbola, impact parameter, B-vector) now exists, and the planner's
  single-flyby and chain readouts now show the impact parameter b alongside the
  periapsis and turn (and the flight console reads out the flown pass's recorded
  geometry). Still to do: an interactive B-plane aim control (drag the B-vector /
  impact parameter), and the pure-B-plane in-sim pass noted under "Gravity assists"
  (the connecting velocity is assigned to thread the chain today).
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
  read-time readout — golden hash unmoved. **Drive waste-heat now tracks the live
  engine set — DONE:** the thrusting-drive signature (`ships.ts shipThermalState`)
  computed its waste heat from the *rated* `stage.thrust`/`isp`, so a solar-electric
  drive far from the Sun (power-starved, derated ~1/9 at 3 AU) and a boostered stage
  both mis-reported their IR signature. It now draws on a single shared
  `propulsion.ts liveJetPowerW(stage, r)` — the core's distance-derated `thrustAt()`
  plus every live strap-on booster — the same live engine set the burn integrator
  flies (the `physics-assessment.md` C5 "one live-thrust source"). Pure read-time
  readout ⇒ golden hash unmoved. Review follow-up: `liveJetPowerW` now also drops the
  core term in the "dead core, live booster" phase (core drained, a longer-lived
  booster still firing — `thrustAt` still returns a chemical core's rated thrust at
  propMass 0, so the gate is on `propMass`), and the thermal waste fraction (1−η)/η
  uses the drive's OWN efficiency (`stage.electric?.eta`) where declared, falling back
  to the generic value for chemical/NTR drives (behaviour-neutral today — every
  catalog electric drive is η=0.6). +6 tests total (`propulsion.test.ts`
  derating/booster/dead-core cases; `sim.test.ts` 1 AU vs 3 AU derating and an
  η-specific waste-heat comparison). Still to
  do: a second optical band split (reflected-sunlight vs thermal-IR with separate
  apertures/backgrounds) and a diffraction-limited angular-resolution / astrometric
  model.
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
- **More bodies** — DONE: 130 bodies (dwarfs, asteroids, gas-giant & other moons,
  plus TNOs and comets) on the fixed-J2000-conic (`FixedHelioRow`) + `MoonRow`
  paths, Horizons-checked — including a deep moon roster (inner + irregular
  satellites of the four giants) and the small-body populations grouped by region
  in the navigator (near-Earth, main belt, Trojans, Kuiper belt, scattered disc,
  inner Oort cloud). **Pluto's four small moons (Styx/Nix/Kerberos/Hydra) — DONE:**
  they orbit the Pluto–Charon **barycentre**, not Pluto's centre, so each carries an
  `orbitsBarycenter` flag and `ephemeris.ts` builds its conic about the barycentre
  (mu = μ_Pluto + μ_Charon + μ_moon) and adds the parent→barycentre offset — the same
  external point Pluto and Charon visibly circle, validated against Horizons `@9`.
  **Ring/spin orientation — DONE:** a body carrying an IAU pole (`poleRaDeg/poleDecDeg`,
  the four giants) has its rendered globe & rings aimed along the real pole
  (`poleToEcliptic`), so Saturn's rings lie in the plane its equatorial moons orbit in
  rather than crossed against them. Still to do: irregular-moon precession; comet
  outgassing/non-gravitational forces; the engine's surface/launch frame still uses
  the azimuth-free `spinPole` (fine — only matters for bodies with landed pads, which
  carry no `poleRaDeg`).
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
  interstellar leg drawn at its true position along the way. **Follow a ship in the
  interstellar view — DONE:** the camera no longer hard-locks on Sol; a
  `SceneManager.interstellarFocus` selection + per-frame `followInterstellar(pos)` (driven
  by the view's `updateFocus()` from the followed ship's scaled position) locks the camera
  onto a craft in transit and tracks it, shifting look-at + camera together so orbit/zoom
  are preserved; surfaced as a HUD **FOLLOW** selector (`interstellarFleet(world)`), pre-armed
  on dispatch, cleared by `R`. Render/UI only ⇒ golden hash unmoved. **Click-to-focus a star — DONE:**
  click a star marker (a screen-space nearest-marker pick reusing the `placeLabel` projection — robust
  for the screen-fixed sprites a `THREE.Raycaster` handles poorly) or pick from a new nav-dock **STARS**
  list (`interstellarStarList()`, nearest-first) to frame that system through the SAME `followInterstellar`
  plumbing; the dock footer reads out its live distance / light-time / spectral type / luminosity / mass
  (`showStarReadout`). Render/UI only ⇒ golden hash unmoved. Still to do: a smooth eased
  follow transition (it re-homes in one frame today); reconcile the in-system ship in-transit
  streak (still on the legacy compressed shell) into the interstellar view; an optional faint deep-sky
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
- **Latitude-dependent launch rotation bonus** — `ascentBudget` credits the full
  EQUATORIAL surface speed (~465 m/s on Earth) regardless of pad latitude; a real pad
  at latitude φ inherits only `v_rot·cos φ` (zero at the poles). Thread the launch
  latitude (the landed `surfaceDir.z` ⇒ the design inclination) through `AscentParams`
  and scale the bonus by cos φ. Slightly over-credits high-inclination launches today
  (e.g. ~176 m/s for a 51.6° Soyuz pad); a few of the marginal launchers would need a
  small re-fit against the corrected budget.

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
