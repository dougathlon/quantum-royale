import { describe, expect, it } from "vitest";

import { BetLedger } from "../../src/betting/BetLedger";
import type { ChickenId } from "../../src/content/chickens";

const VELVET: ChickenId = "velvet-talon";
const COMET: ChickenId = "cornfield-comet";
const SCARLET: ChickenId = "scarlet-bantam";

describe("BetLedger", () => {
  it("starts with 100 uncommitted points and records one persistent decision per intermission", () => {
    const ledger = new BetLedger();

    expect(ledger.snapshot()).toEqual({
      startingPoints: 100,
      remainingPoints: 100,
      tickets: [],
      skippedAfterRounds: [],
      settled: false,
      winnerId: null,
      winningReturn: 0,
      finalPoints: null,
    });

    expect(ledger.place(1, VELVET, 15)).toEqual({
      afterRound: 1,
      chickenId: VELVET,
      stake: 15,
    });
    ledger.skip(2);
    ledger.place(3, COMET, 25);

    expect(ledger.snapshot()).toMatchObject({
      remainingPoints: 60,
      tickets: [
        { afterRound: 1, chickenId: VELVET, stake: 15 },
        { afterRound: 3, chickenId: COMET, stake: 25 },
      ],
      skippedAfterRounds: [2],
    });
    expect(ledger.hasDecision(1)).toBe(true);
    expect(ledger.hasDecision(2)).toBe(true);
    expect(ledger.hasDecision(3)).toBe(true);
  });

  it("rejects a second ticket or skip after an intermission already has a decision", () => {
    const betFirst = new BetLedger();
    betFirst.place(1, VELVET, 10);
    const afterBet = betFirst.snapshot();

    expect(() => betFirst.place(1, COMET, 5)).toThrow(
      "A decision already exists after Round 1.",
    );
    expect(() => betFirst.skip(1)).toThrow(
      "A decision already exists after Round 1.",
    );
    expect(betFirst.snapshot()).toEqual(afterBet);

    const skipFirst = new BetLedger();
    skipFirst.skip(2);
    const afterSkip = skipFirst.snapshot();

    expect(() => skipFirst.place(2, VELVET, 10)).toThrow(
      "A decision already exists after Round 2.",
    );
    expect(() => skipFirst.skip(2)).toThrow(
      "A decision already exists after Round 2.",
    );
    expect(skipFirst.snapshot()).toEqual(afterSkip);
  });

  it("accepts only the three exposed intermission identifiers", () => {
    for (const afterRound of [0, 4, -1, 99]) {
      const ledger = new BetLedger();
      const before = ledger.snapshot();

      expect(() => ledger.place(afterRound as 1 | 2 | 3, VELVET, 10)).toThrow(
        "Bets are only accepted after Rounds 1–3.",
      );
      expect(() => ledger.skip(afterRound as 1 | 2 | 3)).toThrow(
        "Bets are only accepted after Rounds 1–3.",
      );
      expect(ledger.snapshot()).toEqual(before);
    }
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("rejects invalid stake %s without mutating the ledger", (stake) => {
    const ledger = new BetLedger();
    const before = ledger.snapshot();

    expect(() => ledger.place(1, VELVET, stake)).toThrow(
      "Stake must be a positive whole number.",
    );
    expect(ledger.snapshot()).toEqual(before);
  });

  it("rejects unknown chickens and stakes above the remaining bankroll atomically", () => {
    const unknownChicken = "not-a-chicken" as ChickenId;
    const ledger = new BetLedger();

    expect(() => ledger.place(1, unknownChicken, 10)).toThrow(
      "Unknown chicken.",
    );
    expect(ledger.snapshot().remainingPoints).toBe(100);

    ledger.place(1, VELVET, 60);
    const beforeRejectedStake = ledger.snapshot();

    expect(() => ledger.place(2, COMET, 41)).toThrow(
      "Stake exceeds uncommitted points.",
    );
    expect(ledger.snapshot()).toEqual(beforeRejectedStake);

    ledger.place(2, COMET, 40);
    expect(ledger.snapshot().remainingPoints).toBe(0);
    expect(() => ledger.place(3, SCARLET, 1)).toThrow(
      "Stake exceeds uncommitted points.",
    );
  });

  it("skipping commits no points and remains visible in the decision history", () => {
    const ledger = new BetLedger();

    ledger.skip(3);
    ledger.skip(1);

    expect(ledger.snapshot()).toMatchObject({
      remainingPoints: 100,
      tickets: [],
      skippedAfterRounds: [1, 3],
    });
  });

  it("returns exactly six times each winning stake including the stake", () => {
    const ledger = new BetLedger();
    ledger.place(1, VELVET, 10);
    ledger.place(2, COMET, 20);
    ledger.skip(3);

    expect(ledger.settle(VELVET)).toEqual({
      startingPoints: 100,
      remainingPoints: 70,
      tickets: [
        { afterRound: 1, chickenId: VELVET, stake: 10 },
        { afterRound: 2, chickenId: COMET, stake: 20 },
      ],
      skippedAfterRounds: [3],
      settled: true,
      winnerId: VELVET,
      winningReturn: 60,
      finalPoints: 130,
    });
  });

  it("sums multiple winning tickets and gives losing tickets a zero return", () => {
    const ledger = new BetLedger();
    ledger.place(1, VELVET, 10);
    ledger.place(2, VELVET, 15);
    ledger.place(3, SCARLET, 20);

    expect(ledger.settle(VELVET)).toMatchObject({
      remainingPoints: 55,
      winningReturn: 150,
      finalPoints: 205,
    });

    const allLosing = new BetLedger();
    allLosing.place(1, COMET, 30);
    allLosing.skip(2);
    allLosing.skip(3);

    expect(allLosing.settle(SCARLET)).toMatchObject({
      remainingPoints: 70,
      winningReturn: 0,
      finalPoints: 70,
    });
  });

  it("locks placement, skipping, and repeated settlement after final settlement", () => {
    const ledger = new BetLedger();
    ledger.place(1, VELVET, 10);
    const settled = ledger.settle(VELVET);

    expect(() => ledger.place(2, COMET, 10)).toThrow("Betting is settled.");
    expect(() => ledger.skip(2)).toThrow("Betting is settled.");
    expect(() => ledger.settle(COMET)).toThrow("Bets are already settled.");
    expect(ledger.snapshot()).toEqual(settled);
  });
});
