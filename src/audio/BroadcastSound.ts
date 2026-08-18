import type { FramePacket, MatchEvent } from "../simulation/types";

export type SoundCue =
  | "peck"
  | "guard"
  | "cover"
  | "shield"
  | "approach"
  | "withdraw"
  | "hurt"
  | "knockdown"
  | "recover"
  | "branch-matched"
  | "branch-split"
  | "round"
  | "role";

export interface SoundAudit {
  readonly eventId: number;
  readonly cue: SoundCue;
}

export interface PlannedSoundCue extends SoundAudit {
  readonly priority: number;
  readonly order: number;
}

export function soundCuesForEvent(event: MatchEvent): readonly SoundCue[] {
  switch (event.type) {
    case "INTERACTION_RESOLVED": {
      const cues: SoundCue[] = [];
      if (event.actions.a === "attack" || event.actions.b === "attack")
        cues.push("peck");
      if (event.actions.a === "guard" || event.actions.b === "guard")
        cues.push("guard");
      if (event.actions.a === "cover" || event.actions.b === "cover")
        cues.push("cover");
      if (event.actions.a === "approach" || event.actions.b === "approach")
        cues.push("approach");
      if (event.actions.a === "withdraw" || event.actions.b === "withdraw")
        cues.push("withdraw");
      if (event.consequences.damage.some((entry) => entry.shieldAbsorbed > 0))
        cues.push("shield");
      if (event.consequences.damage.some((entry) => entry.actualDamage > 0))
        cues.push("hurt");
      return [...new Set(cues)];
    }
    case "KNOCKDOWN":
      return ["knockdown"];
    case "RECOVERED":
      return ["recover"];
    case "CHECKPOINT_SELECTED":
      return [
        event.branchLabel === "MATCHED_ACTION"
          ? "branch-matched"
          : "branch-split",
      ];
    case "ROUND_STARTED":
      return ["round"];
    case "ROLE_TRANSITIONED":
      return ["role"];
    default:
      return [];
  }
}

const CUE_PRIORITY: Readonly<Record<SoundCue, number>> = {
  peck: 55,
  guard: 50,
  cover: 65,
  shield: 85,
  approach: 30,
  withdraw: 30,
  hurt: 75,
  knockdown: 95,
  recover: 75,
  "branch-matched": 100,
  "branch-split": 100,
  round: 80,
  role: 90,
};

export function soundPlanForEvents(
  events: readonly MatchEvent[],
  speed: FramePacket["snapshot"]["speed"],
): readonly PlannedSoundCue[] {
  const all = events.flatMap((event, eventIndex) =>
    soundCuesForEvent(event).map((cue, cueIndex) => ({
      eventId: event.eventId,
      cue,
      priority: CUE_PRIORITY[cue],
      order: eventIndex * 16 + cueIndex,
    })),
  );
  if (speed === 1) return all;

  const capacity = speed === 2 ? 5 : 3;
  const ranked = [...all].sort(
    (left, right) =>
      right.priority - left.priority ||
      right.eventId - left.eventId ||
      right.order - left.order,
  );
  const mandatory = ranked.filter(
    (item) => item.priority >= CUE_PRIORITY.shield,
  );
  const optional = ranked
    .filter((item) => item.priority < CUE_PRIORITY.shield)
    .slice(0, Math.max(0, capacity - mandatory.length));
  return [...mandatory, ...optional].sort(
    (left, right) => left.order - right.order,
  );
}

const SHAPE: Readonly<
  Record<SoundCue, readonly [number, number, OscillatorType]>
> = {
  peck: [760, 0.045, "square"],
  guard: [230, 0.07, "square"],
  cover: [510, 0.1, "triangle"],
  shield: [880, 0.09, "sine"],
  approach: [310, 0.07, "triangle"],
  withdraw: [205, 0.09, "triangle"],
  hurt: [125, 0.08, "sawtooth"],
  knockdown: [78, 0.18, "square"],
  recover: [390, 0.16, "triangle"],
  "branch-matched": [620, 0.22, "square"],
  "branch-split": [420, 0.22, "square"],
  round: [330, 0.18, "square"],
  role: [470, 0.14, "triangle"],
};

export class BroadcastSound {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private seenEventId = 0;
  private nextSoundTime = 0;
  private muted = false;
  private volume = 0.35;

  constructor(private readonly onAudit: (audit: SoundAudit) => void) {}

  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.applyVolume();
    }
    if (this.context.state === "suspended") await this.context.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolume();
  }
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyVolume();
  }
  isMuted(): boolean {
    return this.muted;
  }

  handlePacket(packet: FramePacket): void {
    if (
      packet.events.some(
        (event) =>
          event.type === "MATCH_STARTED" && event.eventId <= this.seenEventId,
      )
    ) {
      this.seenEventId = 0;
      this.nextSoundTime = this.context?.currentTime ?? 0;
    }
    const freshEvents: MatchEvent[] = [];
    for (const event of packet.events) {
      if (event.eventId <= this.seenEventId) continue;
      this.seenEventId = event.eventId;
      freshEvents.push(event);
    }
    if (!this.context || !this.gain || this.muted) return;

    const plan = soundPlanForEvents(freshEvents, packet.snapshot.speed);
    const minimumGap =
      packet.snapshot.speed === 4
        ? 0.055
        : packet.snapshot.speed === 2
          ? 0.04
          : 0.025;
    const contextNow = this.context.currentTime;
    let scheduledTime = Math.max(contextNow, this.nextSoundTime);
    const played: PlannedSoundCue[] = [];
    for (const item of plan) {
      if (
        packet.snapshot.speed !== 1 &&
        scheduledTime - contextNow > 0.2 &&
        item.priority < CUE_PRIORITY.round
      ) {
        continue;
      }
      if (this.play(item.cue, scheduledTime)) played.push(item);
      scheduledTime += minimumGap;
    }
    this.nextSoundTime = scheduledTime;
    const mostSalient = [...played].sort(
      (left, right) =>
        right.priority - left.priority || right.eventId - left.eventId,
    )[0];
    if (mostSalient)
      this.onAudit({
        eventId: mostSalient.eventId,
        cue: mostSalient.cue,
      });
  }

  private play(cue: SoundCue, when: number): boolean {
    if (!this.context || !this.gain || this.muted) return false;
    const [frequency, duration, type] = SHAPE[cue];
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, when);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(40, frequency * 0.72),
      when + duration,
    );
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(0.34, when + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    oscillator.connect(envelope).connect(this.gain);
    oscillator.start(when);
    oscillator.stop(when + duration + 0.01);
    return true;
  }

  private applyVolume(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }
}
