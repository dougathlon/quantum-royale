import { TUNING } from "../config/tuning";

export const FIELD_VIEW = Object.freeze({ width: 384, height: 256 });

export function projectPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round((x / TUNING.arenaWidth) * FIELD_VIEW.width),
    y: Math.round((y / TUNING.arenaHeight) * FIELD_VIEW.height),
  };
}

export function projectDistance(distance: number): number {
  return Math.max(
    1,
    Math.round((distance / TUNING.arenaWidth) * FIELD_VIEW.width),
  );
}
