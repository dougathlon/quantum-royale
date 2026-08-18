import Phaser from "phaser";
import { chickenAsset } from "../assets/chickenManifest";
import type { ChickenId, ChickenProfile } from "../content/chickens";
import { projectPoint } from "../presentation/projection";
import { deriveShieldPresentation } from "../presentation/shieldStatus";
import type { AnimationIntent, ChickenSnapshot } from "../simulation/types";

export type ChickenPresentationAction = AnimationIntent["action"];

export interface ChickenPresentationEffect {
  readonly action: ChickenPresentationAction;
  readonly targetId: AnimationIntent["targetId"];
  readonly startedTick: number;
  readonly expiresTick: number;
  readonly sourceEventId: number;
}

const FRAME_BY_ACTION: Readonly<Record<ChickenPresentationAction, number>> = {
  attack: 2,
  guard: 3,
  cover: 4,
  ignore: 0,
  approach: 1,
  withdraw: 1,
  hit: 5,
  knockdown: 6,
  recover: 7,
  shield: 4,
};

const PRIORITY: Readonly<Record<ChickenPresentationAction, number>> = {
  attack: 70,
  guard: 55,
  cover: 55,
  ignore: 20,
  approach: 40,
  withdraw: 40,
  hit: 80,
  knockdown: 100,
  recover: 90,
  shield: 50,
};

function numberColor(hex: string): number {
  return Number.parseInt(hex.replace("#", ""), 16);
}

export class ChickenView {
  private readonly root: Phaser.GameObjects.Container;
  private readonly state: Phaser.GameObjects.Graphics;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly name: Phaser.GameObjects.Text;
  private readonly action: Phaser.GameObjects.Text;
  private readonly health: Phaser.GameObjects.Graphics;

  constructor(
    scene: Phaser.Scene,
    private readonly profile: ChickenProfile,
  ) {
    this.root = scene.add.container(0, 0).setDepth(20);
    this.state = scene.add.graphics();
    this.sprite = scene.add
      .sprite(0, 0, chickenAsset(profile.id).textureKey, 0)
      .setOrigin(0.5, 0.75);
    this.health = scene.add.graphics();
    this.name = scene.add
      .text(0, 19, profile.shortName.toUpperCase(), {
        color: profile.accent,
        fontFamily: "monospace",
        fontSize: "7px",
      })
      .setResolution(1)
      .setOrigin(0.5, 0);
    this.action = scene.add
      .text(0, -28, "", {
        color: "#fff4cf",
        backgroundColor: "#171018",
        fontFamily: "monospace",
        fontSize: "7px",
        padding: { x: 2, y: 1 },
      })
      .setResolution(1)
      .setOrigin(0.5, 1)
      .setVisible(false);
    this.root.add([
      this.state,
      this.sprite,
      this.health,
      this.name,
      this.action,
    ]);
  }

  applySnapshot(
    snapshot: ChickenSnapshot,
    effects: readonly ChickenPresentationEffect[],
    _snapshots: ReadonlyMap<ChickenId, ChickenSnapshot>,
    currentTick: number,
  ): void {
    const point = projectPoint(snapshot.x, snapshot.y);
    this.root.setPosition(point.x, point.y).setDepth(20 + point.y / 20);
    this.sprite
      .setFlipX(snapshot.facing < 0)
      .clearTint()
      .setAlpha(1)
      .setRotation(0)
      .setScale(1.5);

    const active = effects
      .filter((effect) => effect.expiresTick > currentTick)
      .sort((left, right) => PRIORITY[right.action] - PRIORITY[left.action])[0];
    const persistent: ChickenPresentationAction | null = snapshot.isDown
      ? "knockdown"
      : snapshot.movementMode !== "wander"
        ? snapshot.movementMode
        : null;
    const action = active?.action ?? persistent;
    const idleFrame = Math.floor(currentTick / 12 + this.profile.qubit) % 2;
    this.sprite.setFrame(action ? FRAME_BY_ACTION[action] : idleFrame);
    if (action === "hit") this.sprite.setTint(0xff665f);
    if (action === "knockdown") this.sprite.setAlpha(0.8);
    if (snapshot.isInvulnerable && !snapshot.isDown) {
      this.sprite.setAlpha(currentTick % 4 < 2 ? 0.55 : 1);
    }

    this.state.clear();
    this.state
      .fillStyle(0x080609, 0.55)
      .fillEllipse(0, 10, snapshot.isDown ? 36 : 26, 6);

    this.health.clear();
    const shield = deriveShieldPresentation(snapshot.shield);
    if (shield.visible) {
      this.health.fillStyle(0x102a2a, 1).fillRect(-19, 10, 38, 2);
      this.health
        .fillStyle(0x59e1d2, 1)
        .fillRect(-19, 10, Math.max(1, Math.round(38 * shield.ratio)), 2)
        .fillRect(21, 9, 7, 2)
        .fillRect(21, 11, 2, 3)
        .fillRect(26, 11, 2, 3)
        .fillRect(23, 14, 3, 2);
    }
    this.health.fillStyle(0x160d12, 1).fillRect(-19, 14, 38, 4);
    this.health
      .fillStyle(numberColor(this.profile.color), 1)
      .fillRect(
        -18,
        15,
        Math.max(0, Math.round((snapshot.health / snapshot.maxHealth) * 36)),
        2,
      );
    this.action
      .setText(action?.toUpperCase() ?? "")
      .setVisible(
        Boolean(action && action !== "approach" && action !== "withdraw"),
      );
  }
}
