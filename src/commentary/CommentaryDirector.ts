import type { ChickenId } from "../content/chickens";
import type {
  CommentaryCategory,
  CommentarySpeaker,
  InteractionResolvedEvent,
} from "../simulation/types";

export interface CommentaryDraft {
  speaker: CommentarySpeaker;
  category: CommentaryCategory;
  priority: number;
  templateId: string;
  sourceEventIds: readonly number[];
  slots: Readonly<Record<string, string | number>>;
  text: string;
}

function hash(parts: readonly (string | number)[]): number {
  let value = 0x811c9dc5;
  for (const part of parts.join("|")) {
    value ^= part.charCodeAt(0);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

function pairKey(a: ChickenId, b: ChickenId): string {
  return [a, b].sort().join("|");
}

function directedKey(a: ChickenId, b: ChickenId): string {
  return `${a}>${b}`;
}

export class CommentaryDirector {
  private round = 1;
  private emittedThisRound = 0;
  private lastOrdinaryTick = Number.NEGATIVE_INFINITY;
  private coverCounts = new Map<string, number>();
  private mutualAttackCounts = new Map<string, number>();
  private pursuitCounts = new Map<string, number>();
  private lastPursuerByPair = new Map<string, ChickenId>();

  constructor(
    private readonly seed: number,
    private readonly nameFor: (id: ChickenId) => string,
  ) {}

  reset(): void {
    this.round = 1;
    this.emittedThisRound = 0;
    this.lastOrdinaryTick = Number.NEGATIVE_INFINITY;
    this.coverCounts.clear();
    this.mutualAttackCounts.clear();
    this.pursuitCounts.clear();
    this.lastPursuerByPair.clear();
  }

  startRound(round: number): void {
    this.round = round;
    this.emittedThisRound = 0;
    this.lastOrdinaryTick = Number.NEGATIVE_INFINITY;
    this.coverCounts.clear();
    this.mutualAttackCounts.clear();
    this.pursuitCounts.clear();
  }

  considerInteraction(event: InteractionResolvedEvent): CommentaryDraft | null {
    const candidates: CommentaryDraft[] = [];
    const [a, b] = event.orderedPair;
    const eventIds = [event.eventId];
    const savingDamage = event.consequences.damage.find(
      (damage) => damage.savingSourceIds.length > 0,
    );
    if (savingDamage) {
      const saverId = savingDamage.savingSourceIds[0] as ChickenId;
      candidates.push(
        this.draft(
          "shield-save",
          5,
          "shield-save",
          eventIds,
          {
            saver: this.nameFor(saverId),
            target: this.nameFor(savingDamage.targetId),
          },
          [
            `${this.nameFor(saverId)} just kept ${this.nameFor(savingDamage.targetId)} standing. That cover had consequences.`,
            `${this.nameFor(saverId)} supplied the shield between ${this.nameFor(savingDamage.targetId)} and a knockdown.`,
            `${this.nameFor(savingDamage.targetId)} survives the hit because ${this.nameFor(saverId)} banked that shield earlier.`,
            `That is a credited rescue: ${this.nameFor(saverId)} absorbed the decisive damage for ${this.nameFor(savingDamage.targetId)}.`,
          ],
        ),
      );
    }
    const knockdown = event.consequences.knockdowns[0];
    if (knockdown) {
      candidates.push(
        this.draft(
          "knockdown",
          5,
          "knockdown",
          eventIds,
          {
            source: this.nameFor(knockdown.sourceId),
            target: this.nameFor(knockdown.targetId),
          },
          [
            `${this.nameFor(knockdown.sourceId)} puts ${this.nameFor(knockdown.targetId)} on the floor and adds a knockdown to the board.`,
            `${this.nameFor(knockdown.sourceId)} scores on ${this.nameFor(knockdown.targetId)}. That is the number that decides this match.`,
            `${this.nameFor(knockdown.targetId)} is down. ${this.nameFor(knockdown.sourceId)} has converted contact into a point.`,
            `Clean scoring blow from ${this.nameFor(knockdown.sourceId)}: ${this.nameFor(knockdown.targetId)} drops, then will return.`,
          ],
        ),
      );
    }

    for (const consequence of event.consequences.shields) {
      if (consequence.appliedAmount <= 0) continue;
      const key = directedKey(consequence.sourceId, consequence.targetId);
      const count = (this.coverCounts.get(key) ?? 0) + 1;
      this.coverCounts.set(key, count);
      candidates.push(
        this.draft(
          "support",
          2,
          "cover-applied",
          eventIds,
          {
            source: this.nameFor(consequence.sourceId),
            target: this.nameFor(consequence.targetId),
            amount: consequence.appliedAmount,
          },
          [
            `${this.nameFor(consequence.sourceId)} puts ${consequence.appliedAmount} shield on ${this.nameFor(consequence.targetId)}. We will know its value when the next hit lands.`,
            `${this.nameFor(consequence.targetId)} gets cover from ${this.nameFor(consequence.sourceId)}—temporary protection, not a point.`,
            `${this.nameFor(consequence.sourceId)} chooses help over indifference and reinforces ${this.nameFor(consequence.targetId)}.`,
            `A useful link forms: ${this.nameFor(consequence.sourceId)} has just armored ${this.nameFor(consequence.targetId)}.`,
          ],
        ),
      );
      if (count === 3) {
        candidates.push(
          this.draft(
            "pair-pattern",
            3,
            "third-cover",
            eventIds,
            {
              source: this.nameFor(consequence.sourceId),
              target: this.nameFor(consequence.targetId),
              count,
            },
            [
              `${this.nameFor(consequence.sourceId)} has covered ${this.nameFor(consequence.targetId)} three times. That is starting to look like a job.`,
              `Three covers from ${this.nameFor(consequence.sourceId)} to ${this.nameFor(consequence.targetId)}. The desk is officially tracking a pattern.`,
              `${this.nameFor(consequence.targetId)} has now received a third shield from ${this.nameFor(consequence.sourceId)}. This pair keeps reproducing the same relation.`,
              `Cover number three: ${this.nameFor(consequence.sourceId)} repeatedly turns proximity to ${this.nameFor(consequence.targetId)} into protection.`,
            ],
          ),
        );
      }
    }

    if (
      event.context === "X" &&
      event.actions.a === "attack" &&
      event.actions.b === "attack"
    ) {
      const key = pairKey(a, b);
      const count = (this.mutualAttackCounts.get(key) ?? 0) + 1;
      this.mutualAttackCounts.set(key, count);
      if (count === 3) {
        candidates.push(
          this.draft(
            "pair-pattern",
            3,
            "mutual-aggression-three",
            eventIds,
            { a: this.nameFor(a), b: this.nameFor(b), count },
            [
              `${this.nameFor(a)} and ${this.nameFor(b)} have chosen mutual aggression three times. A rivalry has filed its paperwork.`,
              `Third mutual attack for ${this.nameFor(a)} and ${this.nameFor(b)}. Neither bird is misreading the tone.`,
              `${this.nameFor(a)} and ${this.nameFor(b)} collide again—three mutual attacks now, and no one has learned caution.`,
              `This edge of the graph is running hot: ${this.nameFor(a)} and ${this.nameFor(b)} have attacked together three times.`,
            ],
          ),
        );
      }
    }

    if (event.context === "X") {
      const attacks = [event.actions.a, event.actions.b].filter(
        (action) => action === "attack",
      ).length;
      candidates.push(
        this.draft(
          "combat",
          2,
          attacks === 2
            ? "mutual-attack"
            : attacks === 1
              ? "attack-guard"
              : "mutual-guard",
          eventIds,
          { a: this.nameFor(a), b: this.nameFor(b) },
          attacks === 2
            ? [
                `${this.nameFor(a)} and ${this.nameFor(b)} both commit. This is a collision, not a chase.`,
                `Mutual attack: ${this.nameFor(a)} and ${this.nameFor(b)} trade safety for damage.`,
                `${this.nameFor(a)} meets ${this.nameFor(b)} head-on. Both sides chose the aggressive outcome.`,
                `No guard on this exchange—${this.nameFor(a)} and ${this.nameFor(b)} both swing.`,
              ]
            : attacks === 1
              ? [
                  `One attacks and one guards as ${this.nameFor(a)} meets ${this.nameFor(b)}; the joint result decides who absorbs what.`,
                  `${this.nameFor(a)} and ${this.nameFor(b)} split their choices: pressure on one side, defense on the other.`,
                  `An asymmetric clash for ${this.nameFor(a)} and ${this.nameFor(b)}—attack meets guard.`,
                  `The pair disagrees about the moment: one commits, the other braces.`,
                ]
              : [
                  `${this.nameFor(a)} and ${this.nameFor(b)} both guard. Contact produces no scoring blow.`,
                  `A cautious meeting: neither ${this.nameFor(a)} nor ${this.nameFor(b)} turns proximity into damage.`,
                  `Double guard on this edge. The encounter matters, but the health bars do not move.`,
                  `${this.nameFor(a)} and ${this.nameFor(b)} close, brace, and separate without a hit.`,
                ],
        ),
      );
    }

    if (event.context === "Z") {
      const aPursues =
        event.actions.a === "approach" && event.actions.b === "withdraw";
      const bPursues =
        event.actions.b === "approach" && event.actions.a === "withdraw";
      if (aPursues || bPursues) {
        const pursuer = aPursues ? a : b;
        const target = aPursues ? b : a;
        const directed = directedKey(pursuer, target);
        const count = (this.pursuitCounts.get(directed) ?? 0) + 1;
        this.pursuitCounts.set(directed, count);
        const key = pairKey(a, b);
        const previousPursuer = this.lastPursuerByPair.get(key);
        this.lastPursuerByPair.set(key, pursuer);
        if (previousPursuer && previousPursuer !== pursuer) {
          candidates.push(
            this.draft(
              "reversal",
              4,
              "pursuit-reversal",
              eventIds,
              {
                pursuer: this.nameFor(pursuer),
                target: this.nameFor(target),
              },
              [
                `${this.nameFor(target)} did the chasing before. Now ${this.nameFor(pursuer)} is closing the distance.`,
                `The pursuit has reversed: ${this.nameFor(pursuer)} is after ${this.nameFor(target)} now.`,
                `${this.nameFor(pursuer)} turns the pair around; the former target is now doing the retreating.`,
                `Roles reverse inside the encounter: ${this.nameFor(pursuer)} advances and ${this.nameFor(target)} yields ground.`,
              ],
            ),
          );
        } else if (count === 3) {
          candidates.push(
            this.draft(
              "pair-pattern",
              3,
              "third-pursuit",
              eventIds,
              {
                pursuer: this.nameFor(pursuer),
                target: this.nameFor(target),
                count,
              },
              [
                `${this.nameFor(pursuer)} has pursued ${this.nameFor(target)} three times. That is no longer incidental movement.`,
                `Third chase: ${this.nameFor(pursuer)} keeps finding ${this.nameFor(target)} on the other end of an approach.`,
                `${this.nameFor(target)} sees ${this.nameFor(pursuer)} coming again. That is their third opposed movement result.`,
                `Three pursuits bind this pair: ${this.nameFor(pursuer)} repeatedly advances while ${this.nameFor(target)} withdraws.`,
              ],
            ),
          );
        }
      }
      candidates.push(
        this.draft(
          "movement",
          1,
          "movement-pair",
          eventIds,
          { a: this.nameFor(a), b: this.nameFor(b) },
          [
            `${this.nameFor(a)} and ${this.nameFor(b)} receive a new movement relation. Watch where it puts them before the next check.`,
            `The graph does not move bodies by itself; this sampled pair result now becomes approach or withdrawal for ${this.nameFor(a)} and ${this.nameFor(b)}.`,
            `${this.nameFor(a)} and ${this.nameFor(b)} have changed course. The consequence will be whether they create or avoid another encounter.`,
            `A new joint movement instruction is in: ${event.actions.a} for ${this.nameFor(a)}, ${event.actions.b} for ${this.nameFor(b)}.`,
          ],
        ),
      );
    }

    if (
      this.emittedThisRound >= 10 ||
      event.tick - this.lastOrdinaryTick < 60 ||
      candidates.length === 0
    ) {
      return null;
    }
    const selected = candidates.sort(
      (left, right) =>
        right.priority - left.priority ||
        left.templateId.localeCompare(right.templateId),
    )[0] as CommentaryDraft;
    this.emittedThisRound += 1;
    this.lastOrdinaryTick = event.tick;
    return selected;
  }

  private draft(
    category: CommentaryCategory,
    priority: number,
    templateId: string,
    sourceEventIds: readonly number[],
    slots: Readonly<Record<string, string | number>>,
    variants: readonly string[],
  ): CommentaryDraft {
    const variant =
      hash([this.seed, this.round, templateId, ...sourceEventIds]) %
      variants.length;
    const speaker: CommentarySpeaker =
      category === "pair-pattern" ||
      category === "reversal" ||
      variant % 2 === 1
        ? "henrietta-hype"
        : "clive-peckham";
    return {
      speaker,
      category,
      priority,
      templateId: `${templateId}-${variant + 1}`,
      sourceEventIds: [...sourceEventIds],
      slots: { ...slots },
      text: variants[variant] as string,
    };
  }
}
