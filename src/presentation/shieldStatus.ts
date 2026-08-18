import { TUNING } from "../config/tuning";

export interface ShieldPresentation {
  readonly visible: boolean;
  readonly ratio: number;
}

export function deriveShieldPresentation(shield: number): ShieldPresentation {
  const cap = TUNING.supportShield * 2;
  return Object.freeze({
    visible: shield > 0,
    ratio: Math.max(0, Math.min(1, shield / cap)),
  });
}
