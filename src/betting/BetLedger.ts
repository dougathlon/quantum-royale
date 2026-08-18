import { isChickenId, type ChickenId } from "../content/chickens";

export interface BetTicket {
  afterRound: 1 | 2 | 3;
  chickenId: ChickenId;
  stake: number;
}

export interface BetLedgerSnapshot {
  startingPoints: 100;
  remainingPoints: number;
  tickets: readonly BetTicket[];
  skippedAfterRounds: readonly number[];
  settled: boolean;
  winnerId: ChickenId | null;
  winningReturn: number;
  finalPoints: number | null;
}

export class BetLedger {
  private remainingPoints = 100;
  private readonly tickets: BetTicket[] = [];
  private readonly skipped = new Set<number>();
  private settlement: {
    winnerId: ChickenId;
    winningReturn: number;
    finalPoints: number;
  } | null = null;

  place(afterRound: 1 | 2 | 3, chickenId: ChickenId, stake: number): BetTicket {
    this.assertOpen(afterRound);
    if (!isChickenId(chickenId)) throw new Error("Unknown chicken.");
    if (!Number.isInteger(stake) || stake <= 0)
      throw new Error("Stake must be a positive whole number.");
    if (stake > this.remainingPoints)
      throw new Error("Stake exceeds uncommitted points.");
    const ticket = { afterRound, chickenId, stake } as const;
    this.tickets.push(ticket);
    this.remainingPoints -= stake;
    return ticket;
  }

  skip(afterRound: 1 | 2 | 3): void {
    this.assertOpen(afterRound);
    this.skipped.add(afterRound);
  }

  hasDecision(afterRound: number): boolean {
    return (
      this.tickets.some((ticket) => ticket.afterRound === afterRound) ||
      this.skipped.has(afterRound)
    );
  }

  settle(winnerId: ChickenId): BetLedgerSnapshot {
    if (this.settlement) throw new Error("Bets are already settled.");
    const winningReturn = this.tickets
      .filter((ticket) => ticket.chickenId === winnerId)
      .reduce((sum, ticket) => sum + ticket.stake * 6, 0);
    this.settlement = {
      winnerId,
      winningReturn,
      finalPoints: this.remainingPoints + winningReturn,
    };
    return this.snapshot();
  }

  snapshot(): BetLedgerSnapshot {
    return {
      startingPoints: 100,
      remainingPoints: this.remainingPoints,
      tickets: this.tickets.map((ticket) => ({ ...ticket })),
      skippedAfterRounds: [...this.skipped].sort(),
      settled: this.settlement !== null,
      winnerId: this.settlement?.winnerId ?? null,
      winningReturn: this.settlement?.winningReturn ?? 0,
      finalPoints: this.settlement?.finalPoints ?? null,
    };
  }

  private assertOpen(afterRound: 1 | 2 | 3): void {
    if (this.settlement) throw new Error("Betting is settled.");
    if (![1, 2, 3].includes(afterRound))
      throw new Error("Bets are only accepted after Rounds 1–3.");
    if (this.hasDecision(afterRound))
      throw new Error(`A decision already exists after Round ${afterRound}.`);
  }
}
