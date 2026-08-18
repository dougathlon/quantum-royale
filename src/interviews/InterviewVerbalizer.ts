import { CHICKEN_BY_ID, type ChickenId } from "../content/chickens";
import {
  BASE_ROLES,
  ROLE_LABELS,
  type ChickenRoleState,
} from "../roles/roleTypes";
import type {
  CharacterProfile,
  InteractionResolvedEvent,
  StrongestPairHistory,
} from "../simulation/types";

export interface InterviewVerbalizer {
  verbalize(
    profile: Omit<CharacterProfile, "interviewLines">,
  ): readonly string[];
}

function hash(parts: readonly (string | number)[]): number {
  let value = 2166136261;
  for (const character of parts.join("|")) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function strongestPairFor(
  chickenId: ChickenId,
  interactions: readonly InteractionResolvedEvent[],
): StrongestPairHistory | null {
  const byPartner = new Map<
    ChickenId,
    {
      interactions: number;
      covers: number;
      attacks: number;
      pursuits: number;
      ids: number[];
    }
  >();
  for (const event of interactions) {
    const index = event.orderedPair.indexOf(chickenId);
    if (index < 0) continue;
    const partnerId = event.orderedPair[index === 0 ? 1 : 0] as ChickenId;
    const action = index === 0 ? event.actions.a : event.actions.b;
    const record = byPartner.get(partnerId) ?? {
      interactions: 0,
      covers: 0,
      attacks: 0,
      pursuits: 0,
      ids: [],
    };
    record.interactions += 1;
    record.ids.push(event.eventId);
    if (action === "cover") record.covers += 1;
    if (action === "attack") record.attacks += 1;
    if (action === "approach") record.pursuits += 1;
    byPartner.set(partnerId, record);
  }
  const strongest = [...byPartner.entries()].sort(
    (left, right) =>
      right[1].interactions - left[1].interactions ||
      left[0].localeCompare(right[0]),
  )[0];
  if (!strongest) return null;
  return {
    partnerId: strongest[0],
    interactionCount: strongest[1].interactions,
    covers: strongest[1].covers,
    attacks: strongest[1].attacks,
    pursuits: strongest[1].pursuits,
    sourceEventIds: strongest[1].ids,
  };
}

export class DeterministicInterviewVerbalizer implements InterviewVerbalizer {
  constructor(private readonly seed: number) {}

  verbalize(
    profile: Omit<CharacterProfile, "interviewLines">,
  ): readonly string[] {
    const role = profile.finalIdentity.label;
    const summary = profile.matchSummary;
    const partner = profile.strongestPair
      ? (CHICKEN_BY_ID.get(profile.strongestPair.partnerId)?.name ??
        profile.strongestPair.partnerId)
      : null;
    const resultVariants = [
      `“I finished ${profile.rank}${profile.rank === 1 ? "st" : profile.rank === 2 ? "nd" : profile.rank === 3 ? "rd" : "th"} with ${profile.knockdowns} knockdown${profile.knockdowns === 1 ? "" : "s"} and ${summary.damageDealt.toFixed(1)} damage dealt.”`,
      `“The board says rank ${profile.rank}: ${profile.knockdowns} knockdown${profile.knockdowns === 1 ? "" : "s"}, ${summary.damageDealt.toFixed(1)} damage out, ${summary.damageReceived.toFixed(1)} taken.”`,
    ];
    const first = resultVariants[
      hash([this.seed, profile.chickenId, profile.finalIdentity.id]) %
        resultVariants.length
    ] as string;
    const roleLine = `“The final desk reading is ${role}: ${profile.strongestTraceLabel} was my strongest behavioral signal at ${profile.strongestTraceValue.toFixed(1)}.”`;
    const pairLine = partner
      ? `“${partner} was my main counterpart: ${profile.strongestPair?.interactionCount ?? 0} meetings, including ${profile.strongestPair?.attacks ?? 0} attacks, ${profile.strongestPair?.covers ?? 0} covers, and ${profile.strongestPair?.pursuits ?? 0} approaches from me.”`
      : `“I never formed a sustained pair history; the match spread my encounters across the field.”`;
    const actionLine = `“Across ${summary.totalInteractions} pair events, I attacked ${summary.attacks} times, guarded ${summary.guards}, covered ${summary.covers}, approached ${summary.approaches}, and withdrew ${summary.withdrawals}.”`;
    return [first, actionLine, pairLine, roleLine];
  }
}

function matchSummaryFor(
  chickenId: ChickenId,
  interactions: readonly InteractionResolvedEvent[],
): CharacterProfile["matchSummary"] {
  const summary: CharacterProfile["matchSummary"] = {
    damageDealt: 0,
    damageReceived: 0,
    shieldsGranted: 0,
    shieldAbsorbedForOthers: 0,
    knockdownsReceived: 0,
    attacks: 0,
    guards: 0,
    covers: 0,
    approaches: 0,
    withdrawals: 0,
    totalInteractions: 0,
  };
  for (const event of interactions) {
    const index = event.orderedPair.indexOf(chickenId);
    if (index >= 0) {
      summary.totalInteractions += 1;
      const action = index === 0 ? event.actions.a : event.actions.b;
      if (action === "attack") summary.attacks += 1;
      else if (action === "guard") summary.guards += 1;
      else if (action === "cover") summary.covers += 1;
      else if (action === "approach") summary.approaches += 1;
      else if (action === "withdraw") summary.withdrawals += 1;
    }
    for (const damage of event.consequences.damage) {
      if (damage.sourceId === chickenId)
        summary.damageDealt += damage.actualDamage;
      if (damage.targetId === chickenId)
        summary.damageReceived += damage.actualDamage;
      for (const credit of damage.shieldCredits) {
        if (credit.sourceId === chickenId)
          summary.shieldAbsorbedForOthers += credit.amount;
      }
    }
    for (const shield of event.consequences.shields) {
      if (shield.sourceId === chickenId)
        summary.shieldsGranted += shield.appliedAmount;
    }
    for (const knockdown of event.consequences.knockdowns) {
      if (knockdown.targetId === chickenId) summary.knockdownsReceived += 1;
    }
  }
  return summary;
}

export function buildCharacterProfiles(
  seed: number,
  ranking: readonly ChickenId[],
  knockdowns: Readonly<Record<ChickenId, number>>,
  roleStates: Readonly<Record<ChickenId, ChickenRoleState>>,
  interactions: readonly InteractionResolvedEvent[],
): readonly CharacterProfile[] {
  const verbalizer = new DeterministicInterviewVerbalizer(seed);
  return ranking.map((chickenId, index) => {
    const role = roleStates[chickenId];
    const cumulative = Object.fromEntries(
      BASE_ROLES.map((baseRole) => [baseRole, 0]),
    ) as Record<(typeof BASE_ROLES)[number], number>;
    for (const entry of role.history) {
      for (const baseRole of BASE_ROLES)
        cumulative[baseRole] += entry.evidence[baseRole];
    }
    const strongestRole = [...BASE_ROLES].sort(
      (left, right) =>
        cumulative[right] - cumulative[left] || left.localeCompare(right),
    )[0] as (typeof BASE_ROLES)[number];
    const base = {
      chickenId,
      canonicalName: role.canonicalName,
      publicName: role.publicName,
      finalIdentity: role.identity,
      roleHistory: role.history,
      strongestTraceLabel: ROLE_LABELS[strongestRole],
      strongestTraceValue: Math.round(cumulative[strongestRole] * 100) / 100,
      strongestPair: strongestPairFor(chickenId, interactions),
      rank: index + 1,
      knockdowns: knockdowns[chickenId] ?? 0,
      matchSummary: matchSummaryFor(chickenId, interactions),
    };
    return { ...base, interviewLines: verbalizer.verbalize(base) };
  });
}
