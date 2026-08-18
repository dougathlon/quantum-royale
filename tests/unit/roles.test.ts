import { describe, expect, it } from "vitest";

import {
  calculateRoleEvidence,
  updateHistoricalRoleScores,
} from "../../src/roles/RoleEngine";
import {
  BASE_ROLES,
  emptyRoleScores,
  evolvingPublicName,
  hybridIdentityNames,
  identityFromScores,
  modifiersForIdentity,
  transitionKind,
  unformedIdentity,
  type BehavioralTrace,
  type RoleScoreVector,
} from "../../src/roles/roleTypes";

function trace(overrides: Partial<BehavioralTrace> = {}): BehavioralTrace {
  const { actions: actionOverrides, ...traceOverrides } = overrides;
  return {
    round: 1,
    sourceEventIds: [],
    xParticipations: 0,
    yParticipations: 0,
    zParticipations: 0,
    baseDamageGiven: 0,
    baseDamageReceived: 0,
    baseShieldGranted: 0,
    baseShieldAbsorbedForOthers: 0,
    baseShieldAbsorbedReceived: 0,
    shieldSaves: 0,
    knockdownsGiven: 0,
    knockdownsReceived: 0,
    mutualAttacks: 0,
    opposedPursuits: 0,
    pursuitFollowThroughs: 0,
    distinctPursuitTargets: 0,
    positiveEvents: 0,
    distinctPositivePartners: 0,
    maxPairPositiveEvents: 0,
    distinctProtectedPartners: 0,
    endHealth: 12,
    ...traceOverrides,
    actions: {
      attack: 0,
      guard: 0,
      cover: 0,
      ignore: 0,
      approach: 0,
      withdraw: 0,
      ...actionOverrides,
    },
  };
}

function scores(values: Partial<RoleScoreVector>): RoleScoreVector {
  return { ...emptyRoleScores(), ...values };
}

describe("role evidence formulas", () => {
  it("calculates Protector from cover, credited base-shield use, partner diversity, and saves", () => {
    const evidence = calculateRoleEvidence(
      trace({
        yParticipations: 10,
        actions: { cover: 5 } as BehavioralTrace["actions"],
        baseShieldGranted: 8,
        baseShieldAbsorbedForOthers: 6,
        distinctProtectedPartners: 2,
        shieldSaves: 1,
      }),
    );
    expect(evidence.protector).toBe(64.25);
    expect(
      calculateRoleEvidence(
        trace({
          yParticipations: 10,
          actions: { cover: 10 } as BehavioralTrace["actions"],
          baseShieldGranted: 0,
        }),
      ).protector,
    ).toBe(0);
  });

  it("calculates Brawler from attacks, base damage, mutual attacks, and knockdown credit", () => {
    const evidence = calculateRoleEvidence(
      trace({
        xParticipations: 10,
        actions: { attack: 8 } as BehavioralTrace["actions"],
        baseDamageGiven: 6,
        mutualAttacks: 4,
        knockdownsGiven: 1,
      }),
    );
    expect(evidence.brawler).toBe(70);
  });

  it("calculates Pursuer and enforces two opposed pursuits", () => {
    const qualifying = trace({
      zParticipations: 10,
      actions: { approach: 6 } as BehavioralTrace["actions"],
      opposedPursuits: 4,
      pursuitFollowThroughs: 2,
      distinctPursuitTargets: 3,
    });
    expect(calculateRoleEvidence(qualifying).pursuer).toBe(58.5);
    expect(
      calculateRoleEvidence({ ...qualifying, opposedPursuits: 1 }).pursuer,
    ).toBe(0);
  });

  it("calculates Survivor only from base pressure when not knocked down", () => {
    const qualifying = trace({
      baseDamageReceived: 6,
      baseShieldAbsorbedReceived: 2,
      endHealth: 9,
    });
    expect(calculateRoleEvidence(qualifying).survivor).toBe(69.17);
    expect(
      calculateRoleEvidence({ ...qualifying, knockdownsReceived: 1 }).survivor,
    ).toBe(0);
    expect(
      calculateRoleEvidence(trace({ baseDamageReceived: 3.99, endHealth: 12 }))
        .survivor,
    ).toBe(0);
  });

  it("calculates Connector from effective events, partners, and distribution", () => {
    const qualifying = trace({
      yParticipations: 5,
      zParticipations: 5,
      positiveEvents: 4,
      distinctPositivePartners: 3,
      maxPairPositiveEvents: 2,
    });
    expect(calculateRoleEvidence(qualifying).connector).toBe(54.63);
    expect(
      calculateRoleEvidence({ ...qualifying, positiveEvents: 2 }).connector,
    ).toBe(0);
    expect(
      calculateRoleEvidence({
        ...qualifying,
        distinctPositivePartners: 1,
      }).connector,
    ).toBe(0);
  });

  it("calculates Lone Wolf from self-protection, isolation, and inverse coordination", () => {
    const qualifying = trace({
      xParticipations: 4,
      yParticipations: 3,
      zParticipations: 3,
      actions: {
        guard: 3,
        ignore: 2,
        withdraw: 2,
        cover: 1,
        approach: 1,
      } as BehavioralTrace["actions"],
      distinctPositivePartners: 1,
    });
    expect(calculateRoleEvidence(qualifying)["lone-wolf"]).toBe(74.5);
    expect(
      calculateRoleEvidence({
        ...qualifying,
        xParticipations: 2,
        yParticipations: 2,
        zParticipations: 1,
      })["lone-wolf"],
    ).toBe(0);
  });

  it("clamps every component and applies the exact 55/45 history update", () => {
    const extreme = calculateRoleEvidence(
      trace({
        xParticipations: 1,
        actions: { attack: 50 } as BehavioralTrace["actions"],
        baseDamageGiven: 100,
        mutualAttacks: 50,
        knockdownsGiven: 4,
      }),
    );
    expect(extreme.brawler).toBe(100);
    expect(
      updateHistoricalRoleScores(
        scores({ protector: 80, brawler: 30 }),
        scores({ protector: 20, brawler: 90 }),
      ),
    ).toMatchObject({ protector: 53, brawler: 57 });
  });
});

describe("identity thresholds, hybrids, names, and modifiers", () => {
  const hybrids = [
    ["protector", "brawler", "Enforcer"],
    ["protector", "pursuer", "Bodyguard"],
    ["protector", "survivor", "Bulwark"],
    ["protector", "connector", "Shepherd"],
    ["protector", "lone-wolf", "Sentinel"],
    ["brawler", "pursuer", "Marauder"],
    ["brawler", "survivor", "Scrapper"],
    ["brawler", "connector", "Captain"],
    ["brawler", "lone-wolf", "Renegade"],
    ["pursuer", "survivor", "Escape Artist"],
    ["pursuer", "connector", "Scout"],
    ["pursuer", "lone-wolf", "Tracker"],
    ["survivor", "connector", "Anchor"],
    ["survivor", "lone-wolf", "Holdout"],
    ["connector", "lone-wolf", "Maverick"],
  ] as const;

  it("uses the exact Unformed, Emerging, and Established thresholds", () => {
    expect(identityFromScores(scores({ protector: 41.99 })).stage).toBe(
      "unformed",
    );
    expect(identityFromScores(scores({ protector: 42 })).stage).toBe(
      "emerging",
    );
    expect(identityFromScores(scores({ protector: 57.99 })).stage).toBe(
      "emerging",
    );
    expect(identityFromScores(scores({ protector: 58 })).stage).toBe(
      "established",
    );
  });

  it.each(hybrids)("maps %s + %s to %s", (first, second, label) => {
    const identity = identityFromScores(scores({ [first]: 64, [second]: 60 }));
    expect(identity.label).toBe(label);
    expect(identity.components).toEqual([first, second]);
  });

  it("uses a hybrid only when the second score is at least 42 and within eight points", () => {
    expect(
      identityFromScores(scores({ protector: 60, brawler: 51.99 })).label,
    ).toBe("Protector");
    expect(
      identityFromScores(scores({ protector: 49, brawler: 41.99 })).label,
    ).toBe("Protector");
    expect(hybridIdentityNames()).toHaveLength(15);
  });

  it("keeps emerging identities neutral and halves, rather than multiplies, hybrid modifiers", () => {
    expect(
      modifiersForIdentity(identityFromScores(scores({ protector: 50 }))),
    ).toMatchObject({ shieldBonus: 0, attackDamageBonus: 0 });
    expect(
      modifiersForIdentity(
        identityFromScores(scores({ protector: 64, brawler: 60 })),
      ),
    ).toMatchObject({ shieldBonus: 0.25, attackDamageBonus: 0.125 });
  });

  it("renders canonical, unformed, emerging base, emerging hybrid, and established names", () => {
    expect(
      evolvingPublicName("buttercup-blitz", unformedIdentity(), false),
    ).toBe("Buttercup Blitz");
    expect(
      evolvingPublicName("buttercup-blitz", unformedIdentity(), true),
    ).toBe("Buttercup “The Unwritten” Blitz");
    expect(
      evolvingPublicName(
        "buttercup-blitz",
        identityFromScores(scores({ protector: 50 })),
        true,
      ),
    ).toBe("Buttercup “Rising Shield” Blitz");
    expect(
      evolvingPublicName(
        "buttercup-blitz",
        identityFromScores(scores({ protector: 50, brawler: 48 })),
        true,
      ),
    ).toBe("Buttercup “Emerging Enforcer” Blitz");
    expect(
      evolvingPublicName(
        "buttercup-blitz",
        identityFromScores(scores({ protector: 64, brawler: 60 })),
        true,
      ),
    ).toBe("Buttercup “The Enforcer” Blitz");
  });

  it("classifies emergence, strengthening, weakening, replacement, hybridization, and loss", () => {
    const unformed = unformedIdentity();
    const emergingProtector = identityFromScores(scores({ protector: 50 }));
    const establishedProtector = identityFromScores(scores({ protector: 60 }));
    const emergingBrawler = identityFromScores(scores({ brawler: 50 }));
    const hybrid = identityFromScores(scores({ protector: 60, brawler: 58 }));
    expect(transitionKind(unformed, emergingProtector)).toBe("emerged");
    expect(transitionKind(emergingProtector, establishedProtector)).toBe(
      "strengthened",
    );
    expect(transitionKind(establishedProtector, emergingProtector)).toBe(
      "weakened",
    );
    expect(transitionKind(emergingProtector, emergingBrawler)).toBe("replaced");
    expect(transitionKind(establishedProtector, hybrid)).toBe("hybridized");
    expect(transitionKind(emergingProtector, unformed)).toBe("lost");
  });
});

describe("synthetic role-migration algorithm", () => {
  it("can remove an established role from one chicken while establishing it on another without claiming quantum evidence", () => {
    const oldVelvet = scores({ protector: 60 });
    const oldComet = scores({ protector: 50 });
    const nextVelvet = updateHistoricalRoleScores(oldVelvet, emptyRoleScores());
    const nextComet = updateHistoricalRoleScores(
      oldComet,
      scores({ protector: 90 }),
    );

    expect(identityFromScores(oldVelvet)).toMatchObject({
      stage: "established",
      label: "Protector",
    });
    expect(identityFromScores(nextVelvet).stage).toBe("unformed");
    expect(identityFromScores(nextComet)).toMatchObject({
      stage: "established",
      label: "Protector",
    });
  });

  it("removes a modifier immediately when an established identity weakens", () => {
    for (const role of BASE_ROLES) {
      const established = identityFromScores(scores({ [role]: 60 }));
      const weakened = identityFromScores(scores({ [role]: 50 }));
      expect(transitionKind(established, weakened)).toBe("weakened");
      expect(modifiersForIdentity(weakened)).toEqual(
        modifiersForIdentity(unformedIdentity()),
      );
    }
  });
});
