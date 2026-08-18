export const CHICKEN_IDS = [
  "velvet-talon",
  "cornfield-comet",
  "scarlet-bantam",
  "midnight-rooster",
  "buttercup-blitz",
  "silver-drumstick",
] as const;

export type ChickenId = (typeof CHICKEN_IDS)[number];

export interface ChickenProfile {
  id: ChickenId;
  qubit: number;
  givenName: string;
  familyName: string;
  name: string;
  shortName: string;
  color: string;
  darkColor: string;
  accent: string;
  spriteKey: string;
}

export const CHICKENS: readonly ChickenProfile[] = [
  {
    id: "velvet-talon",
    qubit: 0,
    givenName: "Velvet",
    familyName: "Talon",
    name: "Velvet Talon",
    shortName: "Velvet",
    color: "#763d89",
    darkColor: "#3e214a",
    accent: "#f2c4ff",
    spriteKey: "chicken-velvet",
  },
  {
    id: "cornfield-comet",
    qubit: 1,
    givenName: "Cornfield",
    familyName: "Comet",
    name: "Cornfield Comet",
    shortName: "Comet",
    color: "#df9d22",
    darkColor: "#784d11",
    accent: "#fff0a8",
    spriteKey: "chicken-comet",
  },
  {
    id: "scarlet-bantam",
    qubit: 2,
    givenName: "Scarlet",
    familyName: "Bantam",
    name: "Scarlet Bantam",
    shortName: "Scarlet",
    color: "#ce3e49",
    darkColor: "#6d1d25",
    accent: "#ffd0c7",
    spriteKey: "chicken-scarlet",
  },
  {
    id: "midnight-rooster",
    qubit: 3,
    givenName: "Midnight",
    familyName: "Rooster",
    name: "Midnight Rooster",
    shortName: "Midnight",
    color: "#24465f",
    darkColor: "#0d222f",
    accent: "#80d0e6",
    spriteKey: "chicken-midnight",
  },
  {
    id: "buttercup-blitz",
    qubit: 4,
    givenName: "Buttercup",
    familyName: "Blitz",
    name: "Buttercup Blitz",
    shortName: "Buttercup",
    color: "#edd34f",
    darkColor: "#837321",
    accent: "#fffbd0",
    spriteKey: "chicken-buttercup",
  },
  {
    id: "silver-drumstick",
    qubit: 5,
    givenName: "Silver",
    familyName: "Drumstick",
    name: "Silver Drumstick",
    shortName: "Silver",
    color: "#aeb9bd",
    darkColor: "#4a555a",
    accent: "#f1f8f9",
    spriteKey: "chicken-silver",
  },
] as const;

export const CHICKEN_BY_ID = new Map(
  CHICKENS.map((chicken) => [chicken.id, chicken]),
);
export const CHICKEN_BY_QUBIT = new Map(
  CHICKENS.map((chicken) => [chicken.qubit, chicken]),
);

export function isChickenId(value: unknown): value is ChickenId {
  return (
    typeof value === "string" &&
    (CHICKEN_IDS as readonly string[]).includes(value)
  );
}
