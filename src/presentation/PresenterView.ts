import { CHICKEN_BY_ID, type ChickenId } from "../content/chickens";
import type { FixtureBank } from "../fixtures/types";
import type { FramePacket } from "../simulation/types";
import { drawBitmapText } from "./bitmapAlphabet";
import {
  PresentationDirector,
  type PresentationFocus,
} from "./PresentationDirector";

const FRAME = 24;
const COLOR = { X: "#ff5a4f", Y: "#59e1d2", Z: "#6aa8ff" } as const;

export class PresenterView {
  private readonly context: CanvasRenderingContext2D;
  private readonly director: PresentationDirector;
  private readonly images = new Map<string, HTMLImageElement>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    bank: FixtureBank,
  ) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Presenter canvas requires a 2D context.");
    this.context = context;
    this.context.imageSmoothingEnabled = false;
    this.director = new PresentationDirector(bank);
  }

  render(packet: FramePacket): PresentationFocus {
    if (packet.events.some((event) => event.type === "MATCH_STARTED"))
      this.director.reset();
    const focus = this.director.update(packet);
    const left = packet.snapshot.chickens.find(
      (chicken) => chicken.id === focus.orderedPair[0],
    );
    const right = packet.snapshot.chickens.find(
      (chicken) => chicken.id === focus.orderedPair[1],
    );
    if (!left || !right) return focus;

    const ctx = this.context;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#08080b";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = "#151219";
    ctx.fillRect(5, 24, 246, 142);
    ctx.fillStyle = "#32261e";
    for (let y = 35; y < 164; y += 12) {
      for (let x = 10 + ((y / 12) % 2) * 5; x < 250; x += 14)
        ctx.fillRect(x, y, 2, 2);
    }
    drawBitmapText(
      ctx,
      focus.label.slice(0, 29),
      8,
      7,
      2,
      COLOR[focus.context],
    );
    drawBitmapText(
      ctx,
      `EVENT ${focus.sourceEventId ?? "--"}`,
      183,
      176,
      1,
      "#978e82",
    );

    this.drawChicken(
      left.id,
      52,
      64,
      focus.actions?.[0] ?? left.movementMode,
      left.isDown,
    );
    this.drawChicken(
      right.id,
      158,
      64,
      focus.actions?.[1] ?? right.movementMode,
      right.isDown,
    );
    ctx.fillStyle = COLOR[focus.context];
    ctx.fillRect(88, 91, 80, 2);
    ctx.fillRect(92, 87, 2, 10);
    ctx.fillRect(162, 87, 2, 10);
    drawBitmapText(
      ctx,
      CHICKEN_BY_ID.get(left.id)?.shortName ?? left.id,
      32,
      140,
      2,
      "#fff0c9",
    );
    drawBitmapText(
      ctx,
      CHICKEN_BY_ID.get(right.id)?.shortName ?? right.id,
      150,
      140,
      2,
      "#fff0c9",
    );
    if (focus.actions) {
      drawBitmapText(ctx, focus.actions[0], 26, 157, 1, COLOR[focus.context]);
      drawBitmapText(ctx, focus.actions[1], 170, 157, 1, COLOR[focus.context]);
    }
    return focus;
  }

  setTrackedChicken(id: ChickenId): void {
    this.director.setTrackedChicken(id);
  }

  private drawChicken(
    id: string,
    x: number,
    y: number,
    action: string,
    isDown: boolean,
  ): void {
    let image = this.images.get(id);
    if (!image) {
      image = new Image();
      image.src = `${import.meta.env.BASE_URL}assets/pixel/chickens/${id}.png`;
      image.addEventListener("load", () =>
        this.context.drawImage(image as HTMLImageElement, 0, 0, 1, 1),
      );
      this.images.set(id, image);
    }
    if (!image.complete) return;
    const frame = isDown
      ? 6
      : action === "attack"
        ? 2
        : action === "guard"
          ? 3
          : action === "cover"
            ? 4
            : action === "hit"
              ? 5
              : action === "recover"
                ? 7
                : 0;
    this.context.drawImage(image, frame * FRAME, 0, FRAME, FRAME, x, y, 72, 72);
  }
}
