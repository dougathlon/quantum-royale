import type { CommentaryEvent, MatchSnapshot } from "../simulation/types";

export interface GlobalCommentarySelection {
  readonly latest: CommentaryEvent | null;
  readonly intermissionInsights: readonly CommentaryEvent[];
}

export function selectGlobalCommentary(
  snapshot: MatchSnapshot,
): GlobalCommentarySelection {
  return Object.freeze({
    latest: snapshot.commentary.at(-1) ?? null,
    intermissionInsights:
      snapshot.phase === "round"
        ? []
        : snapshot.commentary
            .filter((event) => event.round === snapshot.round)
            .slice(-3),
  });
}
