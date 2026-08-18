import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CHICKEN_ASSET_LIST } from "../../src/assets/chickenManifest";
import { CHICKENS, type ChickenId } from "../../src/content/chickens";
import type { FixtureBank } from "../../src/fixtures/types";
import {
  soundCuesForEvent,
  soundPlanForEvents,
} from "../../src/audio/BroadcastSound";
import { PresentationDirector } from "../../src/presentation/PresentationDirector";
import {
  activeArenaRelation,
  relationExpiresAt,
  updateActiveArenaRelations,
} from "../../src/presentation/activeRelations";
import { deriveArenaPresentation } from "../../src/presentation/arenaFocus";
import { FIELD_VIEW, projectPoint } from "../../src/presentation/projection";
import { deriveShieldPresentation } from "../../src/presentation/shieldStatus";
import { FixtureResolver } from "../../src/fixtures/FixtureResolver";
import { QuantumRoyaleSimulation } from "../../src/simulation/QuantumRoyaleSimulation";
import { comparePairEventToProductControl } from "../../src/technical/pairControlComparison";
import { selectGlobalCommentary } from "../../src/ui/commentarySelection";
import { summarizeEventIds } from "../../src/ui/sourceSummary";
import type {
  FramePacket,
  InteractionResolvedEvent,
  MatchEvent,
  MatchSnapshot,
} from "../../src/simulation/types";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../fixtures/quantum-royale-aer-v1.json", import.meta.url),
    "utf8",
  ),
) as FixtureBank;

function append(packet: FramePacket, events: MatchEvent[]): MatchSnapshot {
  events.push(...packet.events);
  return packet.snapshot;
}

function complete(seed: number): {
  snapshot: MatchSnapshot;
  events: MatchEvent[];
} {
  const simulation = new QuantumRoyaleSimulation(FIXTURE, seed);
  const events: MatchEvent[] = [];
  let snapshot = append(simulation.drainFramePacket(), events);
  while (snapshot.phase !== "finished") {
    if (snapshot.phase === "round") {
      snapshot = append(simulation.advanceTicks(48), events);
    } else {
      simulation.skipBet();
      simulation.continueFromIntermission();
      snapshot = append(simulation.drainFramePacket(), events);
    }
  }
  return { snapshot, events };
}

function logicalDigest(events: readonly MatchEvent[]): string {
  const projection = events
    .filter(
      (event) => event.type !== "BET_PLACED" && event.type !== "BET_SKIPPED",
    )
    .map((event) => {
      if (event.type !== "MATCH_FINISHED") return event;
      const { finalPoints: _finalPoints, ...logical } = event;
      return logical;
    });
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

describe("V2.4 public presentation boundary", () => {
  it("keeps broadcast source summaries compact while preserving the audit count", () => {
    expect(summarizeEventIds([])).toBe("none");
    expect(summarizeEventIds([4, 4, 8, 10], 3)).toBe("#4, #8, #10");
    expect(summarizeEventIds([1, 2, 3, 4, 5], 3)).toBe("#1, #2, #3 +2 more");
  });

  it("keeps immutable complete-history baselines for the default and seed-5 runs", () => {
    const defaultRun = complete(260817);
    const migrationRun = complete(5);
    const defaultDigest = logicalDigest(defaultRun.events);
    const migrationDigest = logicalDigest(migrationRun.events);
    expect(defaultDigest).toBe(
      "384397fa0eccde8f8c856f82d60134b9b8befc8d17ae10d2aa6654384229964e",
    );
    expect(migrationDigest).toBe(
      "35c8295892d01200ba66f39fb704082a75dbdd9403fb4ce07b49218a23e3e9d5",
    );
    expect(defaultRun.snapshot.winnerId).not.toBeNull();
    expect(
      migrationRun.snapshot.roleStates["scarlet-bantam"].history,
    ).toHaveLength(1);
  });

  it("projects the authoritative 960 by 640 field into 384 by 256 without changing simulation coordinates", () => {
    expect(FIELD_VIEW).toEqual({ width: 384, height: 256 });
    expect(projectPoint(0, 0)).toEqual({ x: 0, y: 0 });
    expect(projectPoint(960, 640)).toEqual({ x: 384, y: 256 });
    expect(projectPoint(480, 320)).toEqual({ x: 192, y: 128 });
  });

  it("selects a read-only presenter focus from a frame packet", () => {
    const simulation = new QuantumRoyaleSimulation(FIXTURE, 260817);
    simulation.drainFramePacket();
    const packet = simulation.advanceTicks(50);
    const before = JSON.stringify(packet);
    const focus = new PresentationDirector(FIXTURE).update(packet);
    expect(focus.orderedPair).toHaveLength(2);
    expect(["X", "Y", "Z"]).toContain(focus.context);
    expect(JSON.stringify(packet)).toBe(before);
  });

  it("exposes only the tracked chicken and its currently active relation to the arena", () => {
    const run = complete(5);
    const ordinary = (context: "X" | "Y" | "Z") =>
      run.events.find(
        (event): event is InteractionResolvedEvent =>
          event.type === "INTERACTION_RESOLVED" &&
          event.context === context &&
          !event.spotlight.selected &&
          event.consequences.knockdowns.length === 0 &&
          event.consequences.roleModifiers.length === 0 &&
          !event.consequences.damage.some(
            (damage) => damage.savingSourceIds.length > 0,
          ),
      );

    for (const context of ["X", "Y", "Z"] as const) {
      const event = ordinary(context);
      expect(event).toBeDefined();
      if (!event) continue;
      const director = new PresentationDirector(FIXTURE);
      director.setTrackedChicken(event.orderedPair[0]);
      const focus = director.update({
        snapshot: { ...run.snapshot, tick: event.tick },
        events: [event],
      });
      const expectedUntil =
        context === "X"
          ? event.tick + 16
          : context === "Y"
            ? event.tick + 18
            : Math.max(
                event.tick + 12,
                ...event.consequences.movement.map((item) => item.untilTick),
              );
      expect(focus.activeUntilTick).toBe(expectedUntil);
      expect(deriveArenaPresentation(focus, expectedUntil - 1)).toEqual({
        trackedChickenId: event.orderedPair[0],
        counterpartId: event.orderedPair[1],
        context,
        sourceEventId: event.eventId,
      });
      expect(deriveArenaPresentation(focus, expectedUntil)).toEqual({
        trackedChickenId: event.orderedPair[0],
        counterpartId: null,
        context: null,
        sourceEventId: null,
      });
    }
  });

  it("centralizes relation expiry and removes expired, restarted, and non-round records", () => {
    const run = complete(5);
    const interactions = run.events.filter(
      (event): event is InteractionResolvedEvent =>
        event.type === "INTERACTION_RESOLVED",
    );
    for (const context of ["X", "Y", "Z"] as const) {
      const event = interactions.find(
        (candidate) =>
          candidate.context === context &&
          !candidate.spotlight.selected &&
          candidate.consequences.knockdowns.length === 0 &&
          !candidate.consequences.damage.some(
            (damage) => damage.savingSourceIds.length > 0,
          ),
      );
      expect(event).toBeDefined();
      if (!event) continue;
      const relation = activeArenaRelation(event);
      expect(relation.expiresTick).toBe(relationExpiresAt(event));
      expect(
        updateActiveArenaRelations([], {
          snapshot: {
            ...run.snapshot,
            phase: "round",
            tick: event.tick,
            auditHistory: [event],
          },
          events: [event],
        }),
      ).toEqual([relation]);
      expect(
        updateActiveArenaRelations([relation], {
          snapshot: {
            ...run.snapshot,
            phase: "round",
            tick: relation.expiresTick,
            auditHistory: [event],
          },
          events: [],
        }),
      ).toEqual([]);
    }

    const source = interactions[0];
    expect(source).toBeDefined();
    if (!source) return;
    const relation = activeArenaRelation(source);
    expect(
      updateActiveArenaRelations([relation], {
        snapshot: {
          ...run.snapshot,
          phase: "intermission",
          auditHistory: [source],
        },
        events: [],
      }),
    ).toEqual([]);
    const started = run.events.find((event) => event.type === "MATCH_STARTED");
    expect(started).toBeDefined();
    if (!started) return;
    expect(
      updateActiveArenaRelations([relation], {
        snapshot: {
          ...run.snapshot,
          phase: "round",
          tick: source.tick,
          auditHistory: [started],
        },
        events: [started],
      }),
    ).toEqual([]);
  });

  it("deduplicates unordered pairs using X, then Y, then Z, and newest event ID", () => {
    const run = complete(5);
    const source = run.events.find(
      (event): event is InteractionResolvedEvent =>
        event.type === "INTERACTION_RESOLVED" && !event.spotlight.selected,
    );
    expect(source).toBeDefined();
    if (!source) return;
    const baseTick = source.tick;
    const clone = (
      context: "X" | "Y" | "Z",
      eventId: number,
    ): InteractionResolvedEvent => ({
      ...source,
      eventId,
      tick: baseTick,
      context,
      consequences: {
        ...source.consequences,
        movement:
          context === "Z"
            ? [
                {
                  chickenId: source.orderedPair[0],
                  targetId: source.orderedPair[1],
                  mode: "approach",
                  untilTick: baseTick + 48,
                  roleModifier: null,
                },
              ]
            : [],
        knockdowns: [],
        damage: [],
      },
    });
    const packet: FramePacket = {
      snapshot: {
        ...run.snapshot,
        phase: "round",
        tick: baseTick,
        auditHistory: [clone("Z", 9001), clone("Y", 9002), clone("X", 9000)],
      },
      events: [clone("Z", 9001), clone("Y", 9002), clone("X", 9000)],
    };
    const selected = updateActiveArenaRelations([], packet);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ context: "X", sourceEventId: 9000 });

    const newestX = clone("X", 9003);
    expect(
      updateActiveArenaRelations(selected, {
        snapshot: {
          ...packet.snapshot,
          auditHistory: [...packet.snapshot.auditHistory, newestX],
        },
        events: [newestX],
      }),
    ).toEqual([activeArenaRelation(newestX)]);

    const olderX = clone("X", 9010);
    const longerY = clone("Y", 9011);
    const overlapSnapshot = {
      ...packet.snapshot,
      auditHistory: [olderX, longerY],
    };
    expect(
      updateActiveArenaRelations([], {
        snapshot: overlapSnapshot,
        events: [olderX, longerY],
      })[0],
    ).toMatchObject({ context: "X", sourceEventId: 9010 });
    expect(
      updateActiveArenaRelations([], {
        snapshot: { ...overlapSnapshot, tick: baseTick + 16 },
        events: [],
      }),
    ).toEqual([activeArenaRelation(longerY)]);
  });

  it("derives a pure event-level product control with equal marginals and zero covariance", () => {
    const run = complete(5);
    const event = run.events.find(
      (candidate): candidate is InteractionResolvedEvent =>
        candidate.type === "INTERACTION_RESOLVED",
    );
    expect(event).toBeDefined();
    if (!event) return;
    const beforeBank = JSON.stringify(FIXTURE);
    const beforeEvent = JSON.stringify(event);
    const comparison = comparePairEventToProductControl(FIXTURE, event);
    const stored = comparison.storedVector;
    const control = comparison.controlVector;
    expect(control.pp + control.pm).toBeCloseTo(stored.pp + stored.pm, 12);
    expect(control.pp + control.mp).toBeCloseTo(stored.pp + stored.mp, 12);
    expect(comparison.controlCovariance).toBeCloseTo(0, 12);
    expect(comparison.draw).toBe(event.prngDraw);
    expect(JSON.stringify(FIXTURE)).toBe(beforeBank);
    expect(JSON.stringify(event)).toBe(beforeEvent);

    const reversedPair = [event.orderedPair[1], event.orderedPair[0]] as const;
    const reversedDistribution = new FixtureResolver(
      FIXTURE,
    ).getPairDistribution(
      event.checkpointId,
      [...reversedPair],
      event.context,
      "quantum",
    );
    const reversedEvent: InteractionResolvedEvent = {
      ...event,
      orderedPair: reversedPair,
      probabilities: reversedDistribution.probabilities,
    };
    const reversed = comparePairEventToProductControl(FIXTURE, reversedEvent);
    expect(reversed.orderedPair).toEqual(reversedPair);
    expect(reversed.controlVector.pp + reversed.controlVector.pm).toBeCloseTo(
      reversed.storedVector.pp + reversed.storedVector.pm,
      12,
    );
    expect(reversed.controlVector.pp + reversed.controlVector.mp).toBeCloseTo(
      reversed.storedVector.pp + reversed.storedVector.mp,
      12,
    );
  });

  it("keeps waiting focus and shield status presentation-only and bounded", () => {
    const simulation = new QuantumRoyaleSimulation(FIXTURE, 5);
    const packet = simulation.drainFramePacket();
    const before = JSON.stringify(packet);
    const director = new PresentationDirector(FIXTURE);
    director.setTrackedChicken("buttercup-blitz");
    const focus = director.update(packet);
    expect(focus.activeUntilTick).toBeNull();
    expect(deriveArenaPresentation(focus, packet.snapshot.tick)).toEqual({
      trackedChickenId: "buttercup-blitz",
      counterpartId: null,
      context: null,
      sourceEventId: null,
    });
    expect(deriveShieldPresentation(0)).toEqual({ visible: false, ratio: 0 });
    expect(deriveShieldPresentation(3)).toEqual({ visible: true, ratio: 0.5 });
    expect(deriveShieldPresentation(6)).toEqual({ visible: true, ratio: 1 });
    expect(deriveShieldPresentation(12)).toEqual({ visible: true, ratio: 1 });
    const chickenViewSource = readFileSync(
      new URL("../../src/game/ChickenView.ts", import.meta.url),
      "utf8",
    );
    expect(chickenViewSource).not.toContain("strokeRect(-19, -25, 38, 38)");
    expect(chickenViewSource).not.toContain(
      'snapshot.shield > 0\n          ? "shield"',
    );
    const pixelSource = readFileSync(
      new URL("../../scripts/generate-pixel-assets.mjs", import.meta.url),
      "utf8",
    );
    expect(pixelSource).not.toContain(
      "surface.rect(x - 2, y + 2, 2, 10, cyan)",
    );
    expect(JSON.stringify(packet)).toBe(before);
  });

  it("selects commentary globally without consulting the Coop-Cam subject", () => {
    const run = complete(5);
    const selection = selectGlobalCommentary(run.snapshot);
    expect(selection.latest).toBe(run.snapshot.commentary.at(-1));
    expect(selection.intermissionInsights).toEqual(
      run.snapshot.commentary
        .filter((event) => event.round === run.snapshot.round)
        .slice(-3),
    );
    expect(selection.intermissionInsights).toHaveLength(3);
  });

  it("holds a knockdown close-up against a lower-priority movement event", () => {
    const run = complete(5);
    const knockdowns = run.events.filter((event) => event.type === "KNOCKDOWN");
    const pair = knockdowns
      .map((knockdown) => ({
        knockdown,
        movement: run.events.find(
          (event) =>
            event.type === "INTERACTION_RESOLVED" &&
            event.context === "Z" &&
            event.orderedPair.includes(knockdown.sourceId) &&
            event.tick > knockdown.tick &&
            event.tick < knockdown.tick + 36,
        ),
      }))
      .find(
        (
          candidate,
        ): candidate is {
          knockdown: Extract<MatchEvent, { type: "KNOCKDOWN" }>;
          movement: Extract<MatchEvent, { type: "INTERACTION_RESOLVED" }>;
        } => !!candidate.movement,
      );
    expect(pair).toBeDefined();
    if (!pair) return;

    const director = new PresentationDirector(FIXTURE);
    director.setTrackedChicken(pair.knockdown.sourceId);
    const knockdownFocus = director.update({
      snapshot: { ...run.snapshot, tick: pair.knockdown.tick },
      events: [pair.knockdown],
    });
    const heldFocus = director.update({
      snapshot: { ...run.snapshot, tick: pair.movement.tick },
      events: [pair.movement],
    });
    const expiredFocus = director.update({
      snapshot: { ...run.snapshot, tick: pair.knockdown.tick + 36 },
      events: [pair.movement],
    });

    expect(knockdownFocus.sourceEventId).toBe(pair.knockdown.eventId);
    expect(knockdownFocus.caption).toContain("KNOCKDOWN");
    expect(heldFocus.sourceEventId).toBe(pair.knockdown.eventId);
    expect(expiredFocus.sourceEventId).toBe(pair.movement.eventId);
  });

  it("covers live relation classes while excluding final roles and modifiers from the camera", () => {
    const run = complete(5);
    const ordinary = (context: "X" | "Y" | "Z") =>
      run.events.find(
        (event): event is InteractionResolvedEvent =>
          event.type === "INTERACTION_RESOLVED" &&
          event.context === context &&
          !event.spotlight.selected &&
          event.consequences.knockdowns.length === 0 &&
          event.consequences.roleModifiers.length === 0 &&
          !event.consequences.damage.some(
            (damage) => damage.savingSourceIds.length > 0,
          ),
      );
    const combat = ordinary("X");
    const support = ordinary("Y");
    const movement = ordinary("Z");
    const shieldSave = run.events.find(
      (event): event is InteractionResolvedEvent =>
        event.type === "INTERACTION_RESOLVED" &&
        !event.spotlight.selected &&
        event.consequences.knockdowns.length === 0 &&
        event.consequences.damage.some(
          (damage) => damage.savingSourceIds.length > 0,
        ),
    );
    const knockdown = run.events.find((event) => event.type === "KNOCKDOWN");
    const spotlight = run.events.find(
      (event) => event.type === "CHECKPOINT_SELECTED",
    );

    expect({
      combat: !!combat,
      support: !!support,
      movement: !!movement,
      shieldSave: !!shieldSave,
      knockdown: !!knockdown,
      spotlight: !!spotlight,
    }).toEqual({
      combat: true,
      support: true,
      movement: true,
      shieldSave: true,
      knockdown: true,
      spotlight: true,
    });
    if (
      !combat ||
      !support ||
      !movement ||
      !shieldSave ||
      !knockdown ||
      !spotlight
    )
      return;

    const focusFor = (events: readonly MatchEvent[], trackedId: ChickenId) => {
      const director = new PresentationDirector(FIXTURE);
      director.setTrackedChicken(trackedId);
      return director.update({
        snapshot: {
          ...run.snapshot,
          tick: Math.max(...events.map((event) => event.tick)),
        },
        events,
      });
    };

    expect(focusFor([movement], movement.orderedPair[0]).label).toContain(
      "Z RELATION",
    );
    expect(focusFor([support], support.orderedPair[0]).label).toContain(
      "Y RELATION",
    );
    expect(focusFor([combat], combat.orderedPair[0]).label).toContain(
      "X RELATION",
    );
    expect(focusFor([shieldSave], shieldSave.orderedPair[0]).label).toContain(
      "SHIELD SAVE",
    );
    expect(focusFor([knockdown], knockdown.sourceId).label).toContain(
      "KNOCKDOWN",
    );
    expect(
      focusFor([spotlight], spotlight.resolverEvent.orderedPair[0]).label,
    ).toContain("SPOTLIGHT");

    const unrelated = run.events.find(
      (event): event is InteractionResolvedEvent =>
        event.type === "INTERACTION_RESOLVED" &&
        !event.orderedPair.includes(combat.orderedPair[0]),
    );
    expect(unrelated).toBeDefined();
    if (!unrelated) return;
    expect(
      focusFor([combat, unrelated], combat.orderedPair[0]).sourceEventId,
    ).toBe(combat.eventId);
    expect(
      run.events.some(
        (event) =>
          event.type === "INTERACTION_RESOLVED" &&
          event.consequences.roleModifiers.length > 0,
      ),
    ).toBe(false);
  });

  it("maps audible cues from immutable event types rather than animation timing", () => {
    const run = complete(260817);
    const interaction = run.events.find(
      (event) =>
        event.type === "INTERACTION_RESOLVED" &&
        soundCuesForEvent(event).length > 0,
    );
    const branch = run.events.find(
      (event) => event.type === "CHECKPOINT_SELECTED",
    );
    const role = run.events.find((event) => event.type === "ROLE_TRANSITIONED");
    expect(interaction).toBeDefined();
    expect(branch).toBeDefined();
    expect(role).toBeDefined();
    expect(soundCuesForEvent(interaction as MatchEvent).length).toBeGreaterThan(
      0,
    );
    expect(soundCuesForEvent(branch as MatchEvent)).toEqual([
      branch &&
      branch.type === "CHECKPOINT_SELECTED" &&
      branch.branchLabel === "MATCHED_ACTION"
        ? "branch-matched"
        : "branch-split",
    ]);
    expect(soundCuesForEvent(role as MatchEvent)).toEqual(["role"]);
  });

  it("preserves knockdown cues and their audit priority at every speed", () => {
    const run = complete(5);
    const knockdown = run.events.find((event) => event.type === "KNOCKDOWN");
    const movement = run.events.find(
      (event) => event.type === "INTERACTION_RESOLVED" && event.context === "Z",
    );
    expect(knockdown).toBeDefined();
    expect(movement).toBeDefined();
    if (!knockdown || !movement) return;

    for (const speed of [1, 2, 4] as const) {
      const plan = soundPlanForEvents([movement, knockdown], speed);
      const knockdownCue = plan.find((entry) => entry.cue === "knockdown");
      expect(knockdownCue?.eventId).toBe(knockdown.eventId);
      expect(
        [...plan].sort(
          (left, right) =>
            right.priority - left.priority || right.eventId - left.eventId,
        )[0]?.cue,
      ).toBe("knockdown");
    }
  });

  it("never drops branch, knockdown, role, or shield cues during acceleration", () => {
    const run = complete(5);
    const movement = run.events.find(
      (event) => event.type === "INTERACTION_RESOLVED" && event.context === "Z",
    );
    const shield = run.events.find(
      (event) =>
        event.type === "INTERACTION_RESOLVED" &&
        event.consequences.damage.some((damage) => damage.shieldAbsorbed > 0),
    );
    const knockdown = run.events.find((event) => event.type === "KNOCKDOWN");
    const role = run.events.find((event) => event.type === "ROLE_TRANSITIONED");
    const branch = run.events.find(
      (event) => event.type === "CHECKPOINT_SELECTED",
    );
    expect({
      movement: !!movement,
      shield: !!shield,
      knockdown: !!knockdown,
      role: !!role,
      branch: !!branch,
    }).toEqual({
      movement: true,
      shield: true,
      knockdown: true,
      role: true,
      branch: true,
    });
    if (!movement || !shield || !knockdown || !role || !branch) return;

    for (const speed of [2, 4] as const) {
      const cues = soundPlanForEvents(
        [movement, shield, knockdown, role, branch],
        speed,
      ).map((entry) => entry.cue);
      expect(cues).toEqual(
        expect.arrayContaining([
          "shield",
          "knockdown",
          "role",
          branch.branchLabel === "MATCHED_ACTION"
            ? "branch-matched"
            : "branch-split",
        ]),
      );
    }
  });

  it("uses generated PNG sprite sheets for all six stable chicken identities", () => {
    expect(CHICKEN_ASSET_LIST).toHaveLength(6);
    expect(
      CHICKEN_ASSET_LIST.every(
        (asset) =>
          asset.path.endsWith(".png") &&
          !asset.path.includes("legacy-svg") &&
          asset.frameWidth === 24 &&
          asset.frameHeight === 24,
      ),
    ).toBe(true);
    for (const chicken of CHICKENS) {
      const bytes = readFileSync(
        new URL(
          `../../public/assets/pixel/chickens/${chicken.id}.png`,
          import.meta.url,
        ),
      );
      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(bytes.readUInt32BE(16)).toBe(192);
      expect(bytes.readUInt32BE(20)).toBe(24);
    }
  });

  it("keeps the documented pixel-asset provenance synchronized with exact runtime bytes", () => {
    const expected = new Map([
      [
        "pixel/chickens/buttercup-blitz.png",
        "7077340e6d840f5d0c011169055cb29bb92aa9122bac3c051772be3bc099e4f3",
      ],
      [
        "pixel/chickens/cornfield-comet.png",
        "04c71de900645edccb5878259e69a02bf4f37accb69d942657908c412518430c",
      ],
      [
        "pixel/chickens/midnight-rooster.png",
        "692a6f57a1360d79b81c8c6c23eb715183742a6e9dcd039b2eb02ae9e84c5495",
      ],
      [
        "pixel/chickens/scarlet-bantam.png",
        "f01ad13338279f1621ff86680e9b3a536f5347f1f4c7a4f86eea00636040db51",
      ],
      [
        "pixel/chickens/silver-drumstick.png",
        "b875ee0e871a135fe93abaa05240cae042fb79d1c06381eac100ef4082b881ac",
      ],
      [
        "pixel/chickens/velvet-talon.png",
        "67f61da97711873c83c8fd1f88571764cc29c6b7f1711e7d0b2b089969113ff0",
      ],
      [
        "pixel/commentators/clive-peckham.png",
        "0b46d7d021f21eef916c48a1074670a68915d4a81635527d56f3354d762e0b96",
      ],
      [
        "pixel/commentators/henrietta-hype.png",
        "08d60d0ebf6aba4948a6628f13b4f65a4b9aaff30d39928562371e37483dbe95",
      ],
      [
        "pixel/ui/shield.png",
        "90f6d7522bec051143cf6af139822bf1186af28752dc6bd1af530695dd6e5674",
      ],
    ]);
    const provenance = readFileSync(
      new URL("../../art-source/ART_PROVENANCE.md", import.meta.url),
      "utf8",
    );
    for (const [relativePath, documentedHash] of expected) {
      const bytes = readFileSync(
        new URL(`../../public/assets/${relativePath}`, import.meta.url),
      );
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      expect(actualHash).toBe(documentedHash);
      expect(provenance).toContain(`\`${relativePath}\``);
      expect(provenance).toContain(`\`${actualHash}\``);
    }
  });

  it("pins the pixel-rendering, reduced-motion, and anti-dashboard presentation contract", () => {
    const mainSource = readFileSync(
      new URL("../../src/main.ts", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(
      new URL("../../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(mainSource).toContain("antialias: false");
    expect(mainSource).toContain("pixelArt: true");
    expect(mainSource).toContain("roundPixels: true");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("animation: none !important");
    expect(styles).toContain("transition: none !important");
    expect(styles).toContain(":focus-visible");
    for (const forbidden of [
      "linear-gradient(",
      "radial-gradient(",
      "conic-gradient(",
      "backdrop-filter:",
      "filter: blur(",
    ]) {
      expect(styles).not.toContain(forbidden);
    }
  });

  it("uses direct buttons for winner betting and tracked-chicken focus", () => {
    const uiSource = readFileSync(
      new URL("../../src/ui/GameUI.ts", import.meta.url),
      "utf8",
    );
    expect(uiSource).toContain('data-bet-chicken="${chicken.id}"');
    expect(uiSource).toContain('data-bet-stake="10"');
    expect(uiSource).toContain('data-track-chicken="${chicken.id}"');
    expect(uiSource).toContain("selectGlobalCommentary(snapshot)");
    expect(uiSource).not.toContain("trackedCommentary");
    expect(uiSource).not.toContain("Coop-Cam:");
    expect(uiSource).not.toContain('id="bet-chicken"');
    expect(uiSource).not.toContain('id="tracked-chicken"');
    expect(uiSource).not.toContain('type="number"');
  });

  it("keeps focus and audio modules outside authoritative simulation construction", () => {
    const sources = [
      "../../src/presentation/PresentationDirector.ts",
      "../../src/presentation/PresenterView.ts",
      "../../src/audio/BroadcastSound.ts",
    ].map((relativePath) =>
      readFileSync(new URL(relativePath, import.meta.url), "utf8"),
    );
    for (const source of sources) {
      expect(source).not.toContain("QuantumRoyaleSimulation");
      expect(source).not.toContain("new Phaser.Game");
      expect(source).not.toContain("resolveJointOutcome(");
    }
  });
});
