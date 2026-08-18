import type { ChickenId } from "../content/chickens";
import type { Context } from "../fixtures/types";
import type { PresentationFocus } from "./PresentationDirector";

export interface ArenaPresentationState {
  readonly trackedChickenId: ChickenId;
  readonly counterpartId: ChickenId | null;
  readonly context: Context | null;
  readonly sourceEventId: number | null;
}

export function deriveArenaPresentation(
  focus: PresentationFocus,
  currentTick: number,
): ArenaPresentationState {
  const active =
    focus.sourceEventId !== null &&
    focus.activeUntilTick !== null &&
    currentTick < focus.activeUntilTick;
  return Object.freeze({
    trackedChickenId: focus.orderedPair[0],
    counterpartId: active ? focus.orderedPair[1] : null,
    context: active ? focus.context : null,
    sourceEventId: active ? focus.sourceEventId : null,
  });
}
