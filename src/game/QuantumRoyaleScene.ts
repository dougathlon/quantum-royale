import Phaser from "phaser";
import { preloadChickenAssets } from "../assets/chickenManifest";
import { TUNING } from "../config/tuning";
import { CHICKENS, type ChickenId } from "../content/chickens";
import type { Context } from "../fixtures/types";
import { deriveArenaPresentation } from "../presentation/arenaFocus";
import {
  sameUnorderedPair,
  updateActiveArenaRelations,
  type ActiveArenaRelation,
} from "../presentation/activeRelations";
import type { PresentationFocus } from "../presentation/PresentationDirector";
import { FIELD_VIEW, projectPoint } from "../presentation/projection";
import { QuantumRoyaleSimulation } from "../simulation/QuantumRoyaleSimulation";
import type {
  AnimationIntent,
  FramePacket,
  MatchSnapshot,
} from "../simulation/types";
import {
  ChickenView,
  type ChickenPresentationAction,
  type ChickenPresentationEffect,
} from "./ChickenView";

export const QUANTUM_ROYALE_SCENE_KEY = "quantum-royale";
export type FramePacketCallback = (packet: FramePacket) => void;

const COLOR: Readonly<Record<Context, number>> = {
  X: 0xff5a4f,
  Y: 0x59e1d2,
  Z: 0x6aa8ff,
};
const CONTEXT_LABEL: Readonly<Record<Context, string>> = {
  X: "X COMBAT",
  Y: "Y PROTECTION",
  Z: "Z MOVEMENT",
};
const TRACKED_COLOR = 0xf5c842;
const OBSERVED_RELATION_COLOR = 0x6aa8ff;
const GLOBAL_RELATION_COLOR = 0xa29d96;
const DURATION: Readonly<Record<ChickenPresentationAction, number>> = {
  attack: 8,
  guard: 12,
  cover: 12,
  ignore: 8,
  approach: 12,
  withdraw: 12,
  hit: 7,
  knockdown: TUNING.knockdownTicks,
  recover: 14,
  shield: 12,
};

export class QuantumRoyaleScene extends Phaser.Scene {
  private readonly views = new Map<ChickenId, ChickenView>();
  private readonly effects = new Map<
    ChickenId,
    readonly ChickenPresentationEffect[]
  >();
  private relations!: Phaser.GameObjects.Graphics;
  private trackedLabel!: Phaser.GameObjects.Text;
  private relationLabel!: Phaser.GameObjects.Text;
  private activeRelations: readonly ActiveArenaRelation[] = [];
  private presentationFocus: PresentationFocus | null = null;
  private presentationSnapshot: MatchSnapshot | null = null;
  private presentationReady = false;
  private pendingPacket: FramePacket | null = null;
  private lastAppliedTick = -1;

  constructor(
    private readonly simulation: QuantumRoyaleSimulation,
    private readonly onFramePacket: FramePacketCallback,
  ) {
    super({ key: QUANTUM_ROYALE_SCENE_KEY });
  }

  preload(): void {
    preloadChickenAssets(this);
  }

  create(): void {
    this.cameras.main.setBackgroundColor(0x09070a);
    this.drawField();
    this.relations = this.add.graphics().setDepth(15);
    this.trackedLabel = this.add
      .text(0, 0, "TRACKED", {
        color: "#f5c842",
        backgroundColor: "#080609",
        fontFamily: "monospace",
        fontSize: "5px",
        padding: { x: 1, y: 1 },
      })
      .setResolution(1)
      .setDepth(90)
      .setVisible(false);
    this.relationLabel = this.add
      .text(0, 0, "", {
        color: "#fff4cf",
        backgroundColor: "#080609",
        fontFamily: "monospace",
        fontSize: "5px",
        padding: { x: 2, y: 1 },
      })
      .setResolution(1)
      .setOrigin(0.5)
      .setDepth(90)
      .setVisible(false);
    for (const profile of CHICKENS) {
      this.views.set(profile.id, new ChickenView(this, profile));
    }
    this.presentationReady = true;
    const initialPacket = this.pendingPacket ?? this.simulation.updateFrame(0);
    this.pendingPacket = null;
    this.applyFramePacket(initialPacket);
    this.onFramePacket(initialPacket);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.presentationReady = false;
      this.effects.clear();
      this.activeRelations = [];
      this.views.clear();
    });
  }

  override update(_time: number, delta: number): void {
    if (!this.presentationReady) return;
    const packet = this.simulation.updateFrame(delta / 1_000);
    this.applyFramePacket(packet);
    this.onFramePacket(packet);
  }

  public applyFramePacket(packet: FramePacket): void {
    if (!this.presentationReady) {
      this.pendingPacket = packet;
      return;
    }
    const restarted =
      packet.snapshot.tick < this.lastAppliedTick ||
      packet.events.some((event) => event.type === "MATCH_STARTED");
    if (restarted) {
      this.effects.clear();
      this.activeRelations = [];
      this.presentationFocus = null;
    }
    this.activeRelations = updateActiveArenaRelations(
      this.activeRelations,
      packet,
    );
    if (packet.snapshot.phase === "round") {
      this.captureEffects(packet);
      for (const [id, effects] of this.effects) {
        const active = effects.filter(
          (effect) => effect.expiresTick > packet.snapshot.tick,
        );
        if (active.length) this.effects.set(id, active);
        else this.effects.delete(id);
      }
    } else {
      this.effects.clear();
    }

    this.presentationSnapshot = packet.snapshot;
    this.renderPresentationFocus();
    const snapshots = new Map(
      packet.snapshot.chickens.map((chicken) => [chicken.id, chicken] as const),
    );
    for (const profile of CHICKENS) {
      const chicken = snapshots.get(profile.id);
      const view = this.views.get(profile.id);
      if (!chicken || !view) {
        throw new Error(`Missing field presentation for ${profile.id}.`);
      }
      view.applySnapshot(
        chicken,
        this.effects.get(profile.id) ?? [],
        snapshots,
        packet.snapshot.tick,
      );
    }
    this.lastAppliedTick = packet.snapshot.tick;
  }

  public setPresentationFocus(
    focus: PresentationFocus,
    snapshot: MatchSnapshot,
  ): void {
    this.presentationFocus = focus;
    this.presentationSnapshot = snapshot;
    if (this.presentationReady) this.renderPresentationFocus();
  }

  private drawField(): void {
    const graphics = this.add.graphics().setDepth(0);
    graphics
      .fillStyle(0x09070a, 1)
      .fillRect(0, 0, FIELD_VIEW.width, FIELD_VIEW.height);
    graphics.fillStyle(0x120e0c, 1).fillRect(4, 18, 376, 224);
    graphics.fillStyle(0x39291f, 1);
    for (let y = 23; y < 240; y += 12) {
      for (let x = 9 + ((y / 12) % 2) * 5; x < 380; x += 16) {
        graphics.fillRect(x, y, 2, 2);
      }
    }
    graphics.lineStyle(2, 0xdab45b, 0.8).strokeRect(3, 17, 378, 226);
    graphics.lineStyle(1, 0x8e6b36, 0.55);
    for (let x = 20; x < 380; x += 24) {
      graphics.lineBetween(x, 18, x - 8, 25);
    }
    graphics.fillStyle(0x141016, 1).fillRect(0, 243, 384, 13);
  }

  private renderPresentationFocus(): void {
    this.relations.clear();
    this.trackedLabel.setVisible(false);
    this.relationLabel.setVisible(false);
    if (!this.presentationSnapshot) return;

    const snapshot = this.presentationSnapshot;
    const arenaFocus = this.presentationFocus
      ? deriveArenaPresentation(this.presentationFocus, snapshot.tick)
      : null;
    const selectedPair =
      arenaFocus?.counterpartId && arenaFocus.context
        ? ([arenaFocus.trackedChickenId, arenaFocus.counterpartId] as const)
        : null;
    for (const relation of this.activeRelations) {
      if (selectedPair && sameUnorderedPair(relation.orderedPair, selectedPair))
        continue;
      const left = snapshot.chickens.find(
        (chicken) => chicken.id === relation.orderedPair[0],
      );
      const right = snapshot.chickens.find(
        (chicken) => chicken.id === relation.orderedPair[1],
      );
      if (!left || !right) continue;
      const leftPoint = projectPoint(left.x, left.y);
      const rightPoint = projectPoint(right.x, right.y);
      this.relations
        .lineStyle(1, GLOBAL_RELATION_COLOR, 0.28)
        .lineBetween(
          leftPoint.x,
          leftPoint.y - 7,
          rightPoint.x,
          rightPoint.y - 7,
        );
    }

    if (!arenaFocus) return;
    const tracked = snapshot.chickens.find(
      (chicken) => chicken.id === arenaFocus.trackedChickenId,
    );
    if (!tracked) return;
    const trackedPoint = projectPoint(tracked.x, tracked.y);
    this.drawCornerBrackets(trackedPoint.x, trackedPoint.y - 7, TRACKED_COLOR);
    this.trackedLabel
      .setPosition(trackedPoint.x - 17, trackedPoint.y - 36)
      .setVisible(true);

    if (!arenaFocus.counterpartId || !arenaFocus.context) return;
    const counterpart = snapshot.chickens.find(
      (chicken) => chicken.id === arenaFocus.counterpartId,
    );
    if (!counterpart) return;
    const counterpartPoint = projectPoint(counterpart.x, counterpart.y);
    const color = COLOR[arenaFocus.context];
    this.drawCornerBrackets(counterpartPoint.x, counterpartPoint.y - 7, color);
    this.relations
      .lineStyle(2, OBSERVED_RELATION_COLOR, 0.95)
      .lineBetween(
        trackedPoint.x,
        trackedPoint.y - 7,
        counterpartPoint.x,
        counterpartPoint.y - 7,
      );
    const midpoint = {
      x: (trackedPoint.x + counterpartPoint.x) / 2,
      y: (trackedPoint.y + counterpartPoint.y) / 2,
    };
    const distance = Math.hypot(
      trackedPoint.x - counterpartPoint.x,
      trackedPoint.y - counterpartPoint.y,
    );
    const closePairOffset = midpoint.x > FIELD_VIEW.width - 70 ? -45 : 45;
    const counterpartName =
      CHICKENS.find((profile) => profile.id === counterpart.id)?.shortName ??
      counterpart.id;
    this.relationLabel
      .setText(
        distance < 48
          ? `${CONTEXT_LABEL[arenaFocus.context]} · ${counterpartName.toUpperCase()}`
          : CONTEXT_LABEL[arenaFocus.context],
      )
      .setColor(`#${color.toString(16).padStart(6, "0")}`)
      .setPosition(
        midpoint.x + (distance < 48 ? closePairOffset : 0),
        midpoint.y - (distance < 48 ? 5 : 10),
      )
      .setVisible(true);
  }

  private drawCornerBrackets(x: number, y: number, color: number): void {
    const left = x - 16;
    const right = x + 16;
    const top = y - 18;
    const bottom = y + 18;
    const length = 6;
    this.relations.lineStyle(2, color, 1);
    this.relations
      .lineBetween(left, top, left + length, top)
      .lineBetween(left, top, left, top + length)
      .lineBetween(right, top, right - length, top)
      .lineBetween(right, top, right, top + length)
      .lineBetween(left, bottom, left + length, bottom)
      .lineBetween(left, bottom, left, bottom - length)
      .lineBetween(right, bottom, right - length, bottom)
      .lineBetween(right, bottom, right, bottom - length);
  }

  private captureEffects(packet: FramePacket): void {
    for (const event of packet.events) {
      if (event.type === "INTERACTION_RESOLVED") {
        for (const intent of event.animationIntents) {
          this.recordEffect(intent, event.tick, event.eventId);
        }
      } else if (event.type === "KNOCKDOWN") {
        this.recordEffect(
          {
            chickenId: event.targetId,
            action: "knockdown",
            targetId: event.sourceId,
          },
          event.tick,
          event.eventId,
        );
      } else if (event.type === "RECOVERED") {
        this.recordEffect(
          {
            chickenId: event.chickenId,
            action: "recover",
            targetId: null,
          },
          event.tick,
          event.eventId,
        );
      }
    }
  }

  private recordEffect(
    intent: AnimationIntent,
    startedTick: number,
    sourceEventId: number,
  ): void {
    const current = this.effects.get(intent.chickenId) ?? [];
    const incoming: ChickenPresentationEffect = {
      action: intent.action,
      targetId: intent.targetId,
      startedTick,
      expiresTick: startedTick + DURATION[intent.action],
      sourceEventId,
    };
    this.effects.set(intent.chickenId, [
      ...current.filter((effect) => effect.action !== intent.action),
      incoming,
    ]);
  }
}
