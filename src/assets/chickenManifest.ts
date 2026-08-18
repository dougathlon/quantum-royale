import type Phaser from "phaser";
import { CHICKENS, type ChickenId } from "../content/chickens";

export interface ChickenAssetDefinition {
  readonly chickenId: ChickenId;
  readonly textureKey: string;
  readonly path: string;
  readonly frameWidth: 24;
  readonly frameHeight: 24;
  readonly defaultFacing: "right";
}

const PATH_BY_ID: Readonly<Record<ChickenId, string>> = {
  "velvet-talon": "assets/pixel/chickens/velvet-talon.png",
  "cornfield-comet": "assets/pixel/chickens/cornfield-comet.png",
  "scarlet-bantam": "assets/pixel/chickens/scarlet-bantam.png",
  "midnight-rooster": "assets/pixel/chickens/midnight-rooster.png",
  "buttercup-blitz": "assets/pixel/chickens/buttercup-blitz.png",
  "silver-drumstick": "assets/pixel/chickens/silver-drumstick.png",
};

export const CHICKEN_ASSET_LIST: readonly ChickenAssetDefinition[] =
  CHICKENS.map((chicken): ChickenAssetDefinition => ({
    chickenId: chicken.id,
    textureKey: chicken.spriteKey,
    path: PATH_BY_ID[chicken.id],
    frameWidth: 24,
    frameHeight: 24,
    defaultFacing: "right",
  }));

export const CHICKEN_ASSETS: Readonly<
  Record<ChickenId, ChickenAssetDefinition>
> = Object.freeze(
  Object.fromEntries(
    CHICKEN_ASSET_LIST.map((asset) => [asset.chickenId, asset]),
  ) as Record<ChickenId, ChickenAssetDefinition>,
);

export function chickenAsset(chickenId: ChickenId): ChickenAssetDefinition {
  return CHICKEN_ASSETS[chickenId];
}

export function preloadChickenAssets(scene: Phaser.Scene): void {
  const baseUrl = import.meta.env.BASE_URL;
  for (const asset of CHICKEN_ASSET_LIST) {
    scene.load.spritesheet(asset.textureKey, `${baseUrl}${asset.path}`, {
      frameWidth: asset.frameWidth,
      frameHeight: asset.frameHeight,
    });
  }
}
