import type { QuantumRoyaleSimulation } from "../simulation/QuantumRoyaleSimulation";
import { TUNING } from "../config/tuning";
import {
  CHICKENS,
  CHICKEN_BY_ID,
  CHICKEN_BY_QUBIT,
  isChickenId,
  type ChickenId,
} from "../content/chickens";
import type {
  Context,
  FixtureBank,
  FixtureCheckpoint,
} from "../fixtures/types";
import { EXECUTION_SOURCES } from "../technical/executionSources";
import type {
  CharacterProfile,
  FramePacket,
  InteractionReason,
  InteractionResolvedEvent,
  MatchEvent,
  MatchSnapshot,
} from "../simulation/types";
import { BroadcastSound } from "../audio/BroadcastSound";
import type { PresentationFocus } from "../presentation/PresentationDirector";
import { PresenterView } from "../presentation/PresenterView";
import {
  comparePairEventToProductControl,
  type PairControlComparison,
} from "../technical/pairControlComparison";
import { summarizeEventIds } from "./sourceSummary";
import { selectGlobalCommentary } from "./commentarySelection";

interface GameUIOptions {
  onExternalPacket: (packet: FramePacket) => void;
  onPresentationFocus: (
    focus: PresentationFocus,
    snapshot: MatchSnapshot,
  ) => void;
}

const CONTEXT_LABELS = {
  X: "X · ATTACK / GUARD",
  Y: "Y · COVER / IGNORE",
  Z: "Z · APPROACH / WITHDRAW",
} as const;

const OUTCOME_LABELS = {
  pp: "++",
  pm: "+−",
  mp: "−+",
  mm: "−−",
} as const;

const INTERACTION_REASON_LABELS: Record<InteractionReason, string> = {
  "movement-decision": "movement decision",
  "injury-proximity": "injury + proximity",
  "combat-proximity": "combat proximity",
  "spotlight-fallback": "spotlight fallback",
};

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element ${selector}.`);
  return element;
}

function chickenName(id: ChickenId | null): string {
  if (!id) return "—";
  return CHICKEN_BY_ID.get(id)?.name ?? id;
}

function snapshotChickenName(
  snapshot: MatchSnapshot,
  id: ChickenId | null,
): string {
  if (!id) return "—";
  return snapshot.roleStates[id]?.publicName ?? chickenName(id);
}

function qubitName(qubit: number): string {
  const chicken = CHICKEN_BY_QUBIT.get(qubit);
  return chicken ? `${chicken.name} (q${qubit})` : `q${qubit}`;
}

function formatNumber(value: number, digits = 3): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function formatProbabilityVector(
  probabilities: InteractionResolvedEvent["probabilities"],
): string {
  return (["pp", "pm", "mp", "mm"] as const)
    .map(
      (outcome) =>
        `${OUTCOME_LABELS[outcome]} ${(probabilities[outcome] * 100).toFixed(2)}%`,
    )
    .join(" · ");
}

function describeConsequences(event: InteractionResolvedEvent): string {
  const fragments: string[] = [];
  for (const item of event.consequences.damage) {
    const ignored = item.ignoredReason
      ? ` (${item.ignoredReason}: ignored)`
      : "";
    fragments.push(
      `${chickenName(item.sourceId)} → ${chickenName(item.targetId)}: ${formatNumber(item.actualDamage, 1)} HP${ignored}`,
    );
  }
  for (const item of event.consequences.shields) {
    fragments.push(
      `${chickenName(item.sourceId)} covers ${chickenName(item.targetId)}: +${item.amount} shield`,
    );
  }
  for (const item of event.consequences.movement) {
    const verb = item.mode === "approach" ? "approaches" : "withdraws";
    fragments.push(
      `${chickenName(item.chickenId)} ${verb} ${chickenName(item.targetId)}`,
    );
  }
  for (const item of event.consequences.knockdowns) {
    fragments.push(
      `${chickenName(item.sourceId)} knocks down ${chickenName(item.targetId)}: +1 point`,
    );
  }
  for (const modifier of event.consequences.roleModifiers) {
    fragments.push(
      `${chickenName(modifier.chickenId)} · ${modifier.kind} ${formatNumber(modifier.baseValue)} → ${formatNumber(modifier.appliedValue)} from ${modifier.roleIdentityId}`,
    );
  }
  return (
    fragments.join(" · ") || "No health, shield, movement, or score change."
  );
}

function historyLine(event: MatchEvent): string {
  switch (event.type) {
    case "INTERACTION_RESOLVED":
      return `#${event.eventId} · t${event.tick} · ${CONTEXT_LABELS[event.context]} · ${chickenName(event.orderedPair[0])} / ${chickenName(event.orderedPair[1])} · ${OUTCOME_LABELS[event.jointOutcome]} · ${describeConsequences(event)}`;
    case "KNOCKDOWN":
      return `#${event.eventId} · ${chickenName(event.sourceId)} scored on ${chickenName(event.targetId)} (${event.scoreAfter})`;
    case "RECOVERED":
      return `#${event.eventId} · ${chickenName(event.chickenId)} recovered at full health`;
    case "CHECKPOINT_SELECTED": {
      const resolver = event.resolverEvent;
      return `#${event.eventId} · resolver #${resolver.eventId} at ${resolver.checkpointId} · ${CONTEXT_LABELS[resolver.context]} · ${chickenName(resolver.orderedPair[0])} / ${chickenName(resolver.orderedPair[1])} · draw ${resolver.prngDraw.toFixed(8)} → ${OUTCOME_LABELS[resolver.jointOutcome]} (${resolver.actions.a} / ${resolver.actions.b}) · ${event.branchLabel} selected ${event.childCheckpointId}`;
    }
    case "CHECKPOINT_ACTIVATED":
      return `#${event.eventId} · activated committed checkpoint ${event.checkpointId}`;
    case "SPOTLIGHT_FALLBACK_SCHEDULED":
      return `#${event.eventId} · Round ${event.round} fallback opportunity scheduled at round tick ${event.fallbackDeadlineRoundTick}; window opens at ${event.windowOpensAtRoundTick} · ${CONTEXT_LABELS[event.context]} · ${chickenName(event.orderedPair[0])} / ${chickenName(event.orderedPair[1])}`;
    case "SPOTLIGHT_WINDOW_OPENED":
      return `#${event.eventId} · spotlight window opened at round tick ${event.roundTick}; fallback remains scheduled for ${event.fallbackDeadlineRoundTick} · ${CONTEXT_LABELS[event.context]} · ${chickenName(event.orderedPair[0])} / ${chickenName(event.orderedPair[1])}`;
    case "SPOTLIGHT_FALLBACK_RESERVATION_STARTED":
      return `#${event.eventId} · fallback reservation started at round tick ${event.roundTick}; the pair is withheld from unrelated interactions but can still qualify naturally before the deadline · ${CONTEXT_LABELS[event.context]} · ${chickenName(event.orderedPair[0])} / ${chickenName(event.orderedPair[1])}`;
    case "SPOTLIGHT_FALLBACK_PREPARED": {
      const releasedActiveLock =
        event.actionLockUntilTicksBefore.some(
          (lockUntilTick) => lockUntilTick > event.tick,
        ) || event.pairCooldownUntilTickBefore > event.tick;
      const lockStatus = releasedActiveLock
        ? "scheduler cleared active locks only for"
        : "action and pair locks already available for";
      return `#${event.eventId} · eligible fallback prepared · ${event.qualifyingReason.replaceAll("-", " ")} · distance ${event.distanceBefore.toFixed(1)} → ${event.distanceAfter.toFixed(1)}${event.triggerRange === null ? "" : ` (range ${event.triggerRange})`} · ${lockStatus} ${chickenName(event.orderedPair[0])} / ${chickenName(event.orderedPair[1])}`;
    }
    case "SPOTLIGHT_FALLBACK_DEFERRED":
      return `#${event.eventId} · fallback draw deferred without sampling a down chicken; waiting for timed recovery at tick ${event.earliestRecoveryTick} · ${event.downChickenIds.map(chickenName).join(" / ")}`;
    case "SPOTLIGHT_FALLBACK_USED":
      return `#${event.eventId} · deadline fallback used resolver event #${event.sourceInteractionEventId} at round tick ${event.roundTick} · ${CONTEXT_LABELS[event.context]} · ${chickenName(event.orderedPair[0])} / ${chickenName(event.orderedPair[1])}`;
    case "INTERMISSION_STARTED":
      return `#${event.eventId} · intermission after Round ${event.afterRound}`;
    case "INTERMISSION_ENDED":
      return `#${event.eventId} · betting closed; next round begins`;
    case "BET_PLACED":
      return `#${event.eventId} · bet ${event.stake} on ${chickenName(event.chickenId)}`;
    case "BET_SKIPPED":
      return `#${event.eventId} · betting skipped`;
    case "MATCH_FINISHED":
      return `#${event.eventId} · winner ${chickenName(event.winnerId)} · final bankroll ${event.finalPoints}`;
    case "ROLE_EVALUATED":
      return `#${event.eventId} · ${event.publicName} · ${event.identity.stage} ${event.identity.label} · ${event.transition} · source events ${event.trace.sourceEventIds.join(", ")}`;
    case "ROLE_TRANSITIONED":
      return `#${event.eventId} · ${event.publicName} · ${event.transition}: ${event.previousIdentity.label} → ${event.identity.label} · evaluation #${event.evaluationEventId}`;
    case "COMMENTARY_EMITTED":
      return `#${event.eventId} · desk/${event.speaker} · ${event.text} · sources ${event.sourceEventIds.join(", ")}`;
    case "INTERVIEW_PROFILE_CREATED":
      return `#${event.eventId} · interview profile · ${event.profile.publicName} · ${event.profile.finalIdentity.label}`;
    default:
      return `#${event.eventId} · ${event.type.replaceAll("_", " ").toLowerCase()}`;
  }
}

type HistoryKind =
  "all" | "interaction" | "branch" | "knockdown" | "commentary";

interface HistoryFilters {
  round: "all" | "1" | "2" | "3" | "4";
  chicken: "all" | ChickenId;
  pair: string;
  context: "all" | Context;
  kind: HistoryKind;
}

function eventPair(event: MatchEvent): readonly [ChickenId, ChickenId] | null {
  if (event.type === "INTERACTION_RESOLVED") return event.orderedPair;
  if (event.type === "CHECKPOINT_SELECTED")
    return event.resolverEvent.orderedPair;
  if (
    event.type === "SPOTLIGHT_FALLBACK_SCHEDULED" ||
    event.type === "SPOTLIGHT_WINDOW_OPENED" ||
    event.type === "SPOTLIGHT_FALLBACK_RESERVATION_STARTED" ||
    event.type === "SPOTLIGHT_FALLBACK_PREPARED" ||
    event.type === "SPOTLIGHT_FALLBACK_USED"
  ) {
    return event.orderedPair;
  }
  return null;
}

function eventChickenIds(event: MatchEvent): readonly ChickenId[] {
  const pair = eventPair(event);
  if (pair) return pair;
  switch (event.type) {
    case "KNOCKDOWN":
      return [event.sourceId, event.targetId];
    case "RECOVERED":
      return [event.chickenId];
    case "BET_PLACED":
      return event.chickenId ? [event.chickenId] : [];
    case "MATCH_FINISHED":
      return [event.winnerId];
    case "ROLE_EVALUATED":
    case "ROLE_TRANSITIONED":
      return [event.chickenId];
    case "INTERVIEW_PROFILE_CREATED":
      return [event.profile.chickenId];
    case "SPOTLIGHT_FALLBACK_DEFERRED":
      return event.downChickenIds;
    default:
      return [];
  }
}

function eventContext(event: MatchEvent): Context | null {
  if (event.type === "INTERACTION_RESOLVED") return event.context;
  if (event.type === "CHECKPOINT_SELECTED") return event.resolverEvent.context;
  if (
    event.type === "SPOTLIGHT_FALLBACK_SCHEDULED" ||
    event.type === "SPOTLIGHT_WINDOW_OPENED" ||
    event.type === "SPOTLIGHT_FALLBACK_RESERVATION_STARTED" ||
    event.type === "SPOTLIGHT_FALLBACK_PREPARED" ||
    event.type === "SPOTLIGHT_FALLBACK_USED"
  ) {
    return event.context;
  }
  return null;
}

function eventKind(event: MatchEvent): Exclude<HistoryKind, "all"> | "other" {
  if (event.type === "INTERACTION_RESOLVED") return "interaction";
  if (
    event.type === "CHECKPOINT_SELECTED" ||
    event.type === "CHECKPOINT_ACTIVATED" ||
    event.type.startsWith("SPOTLIGHT_")
  ) {
    return "branch";
  }
  if (event.type === "KNOCKDOWN") return "knockdown";
  if (event.type === "COMMENTARY_EMITTED") return "commentary";
  return "other";
}

function canonicalPairValue(pair: readonly [ChickenId, ChickenId]): string {
  return [...pair].sort().join("|");
}

export class GameUI {
  private readonly root: HTMLElement;
  private readonly simulation: QuantumRoyaleSimulation;
  private readonly bank: FixtureBank;
  private readonly options: GameUIOptions;
  private historyRenderKey = "";
  private latestSnapshot: MatchSnapshot | null = null;
  private pairComparison: PairControlComparison | null = null;
  private previousPhase: MatchSnapshot["phase"] | null = null;
  private interviewIndex = 0;
  private interviewsSkipped = false;
  private started = false;
  private readonly presenter: PresenterView;
  private readonly sound: BroadcastSound;
  private heatmapCheckpointId = "";
  private trackedChickenId: ChickenId = "velvet-talon";
  private selectedBetChickenId: ChickenId = "velvet-talon";
  private selectedBetStake = 10;
  private readonly historyFilters: HistoryFilters = {
    round: "all",
    chicken: "all",
    pair: "all",
    context: "all",
    kind: "all",
  };

  constructor(
    root: HTMLElement,
    simulation: QuantumRoyaleSimulation,
    bank: FixtureBank,
    options: GameUIOptions,
  ) {
    this.root = root;
    this.simulation = simulation;
    this.bank = bank;
    this.options = options;
    this.root.innerHTML = this.markup();
    required<HTMLElement>(this.root, "#desk-slot").append(
      required<HTMLElement>(this.root, "#analysis-desk"),
    );
    required<HTMLElement>(this.root, "#pause-slot").append(
      required<HTMLElement>(this.root, "#intermission"),
      required<HTMLElement>(this.root, "#result-card"),
    );
    this.presenter = new PresenterView(
      required<HTMLCanvasElement>(this.root, "#presenter-canvas"),
      bank,
    );
    this.sound = new BroadcastSound(({ eventId, cue }) => {
      required<HTMLElement>(this.root, "#sound-audit").textContent =
        `SOUND ${cue.toUpperCase()} · EVENT #${eventId}`;
    });
    required<HTMLElement>(this.root, "#source-badge").textContent =
      this.acquisitionLabel();
    this.bindControls();
  }

  render(packet: FramePacket): void {
    const snapshot = packet.snapshot;
    this.latestSnapshot = snapshot;
    const presenterFocus = this.presenter.render(packet);
    this.options.onPresentationFocus(presenterFocus, snapshot);
    required<HTMLElement>(this.root, "#presenter-caption").textContent =
      presenterFocus.caption;
    this.sound.handlePacket(packet);
    this.renderMatchHeader(snapshot);
    this.renderLeaderboard(snapshot);
    this.renderCommentary(snapshot);
    this.renderTechnicalTrace(snapshot);
    this.renderCheckpoint(snapshot);
    this.renderBetting(snapshot);
    this.renderHistory(snapshot);
    this.renderPairComparison();
    this.renderStartGate(snapshot);
  }

  showError(message: string): void {
    const status = required<HTMLElement>(this.root, "#control-status");
    status.textContent = message;
    status.classList.add("is-error");
  }

  private acquisitionLabel(): string {
    const root = this.bank.checkpoints["round-1-root"];
    if (!root) throw new Error("Fixture bank lacks its root checkpoint.");
    const acquisition = root.acquisition;
    return acquisition.providerMode === "batched-hardware"
      ? `BATCHED HARDWARE · ${acquisition.providerName} / ${acquisition.backendName}`
      : `FINITE-SHOT AER · ${acquisition.backendName}`;
  }

  private markup(): string {
    const assetBase = import.meta.env.BASE_URL;
    const trackingButtons = CHICKENS.map(
      (chicken) =>
        `<button type="button" data-track-chicken="${chicken.id}" aria-pressed="${chicken.id === this.trackedChickenId}" style="--chicken-color:${chicken.color}">${chicken.shortName}</button>`,
    ).join("");
    const winnerButtons = CHICKENS.map(
      (chicken) =>
        `<button type="button" data-bet-chicken="${chicken.id}" aria-pressed="${chicken.id === this.selectedBetChickenId}" style="--chicken-color:${chicken.color}"><span>${chicken.name}</span><small data-bet-score>0 knockdowns</small></button>`,
    ).join("");
    const leaderboard = CHICKENS.map(
      (chicken) => `
        <li class="leader-card" data-chicken-card="${chicken.id}" style="--chicken-color:${chicken.color};--chicken-accent:${chicken.accent}">
          <span class="leader-swatch" aria-hidden="true"></span>
          <span class="leader-name" data-public-name>${chicken.name}</span>
          <span class="leader-score-wrap"><strong class="leader-score" data-score>0</strong><small>KO</small></span>
          <span class="leader-health" data-health>12 HP</span>
          <span class="leader-state" data-state>UP</span>
          <span class="leader-health-track" data-health-bar role="progressbar" aria-label="${chicken.name} health" aria-valuemin="0" aria-valuemax="12" aria-valuenow="12"><span data-health-fill></span></span>
          <span class="leader-shield" data-shield hidden><img src="${assetBase}assets/pixel/ui/shield.png" alt="" /><span data-shield-text>0</span><span class="leader-shield-track"><span data-shield-fill></span></span></span>
        </li>`,
    ).join("");
    const chickenFilterOptions = CHICKENS.map(
      (chicken) => `<option value="${chicken.id}">${chicken.name}</option>`,
    ).join("");
    const pairFilterOptions = CHICKENS.flatMap((left, leftIndex) =>
      CHICKENS.slice(leftIndex + 1).map(
        (right) =>
          `<option value="${canonicalPairValue([left.id, right.id])}">${left.shortName} / ${right.shortName}</option>`,
      ),
    ).join("");
    const probabilityRows = (["pp", "pm", "mp", "mm"] as const)
      .map(
        (outcome) => `
          <div class="probability-row" data-probability="${outcome}">
            <span class="probability-key">${OUTCOME_LABELS[outcome]}</span>
            <span class="probability-track"><span class="probability-fill"></span></span>
            <span class="probability-value">—</span>
          </div>`,
      )
      .join("");
    const cumulativeSegments = (["pp", "pm", "mp", "mm"] as const)
      .map(
        (outcome) =>
          `<span class="cumulative-segment" data-cumulative="${outcome}">${OUTCOME_LABELS[outcome]}</span>`,
      )
      .join("");

    return `
      <div class="app-shell">
        <header class="game-header">
          <div>
            <p class="eyebrow">Committed-fixture quantum autobattler</p>
            <h1>Quantum Royale V2.4</h1>
          </div>
          <p class="header-thesis">Quantum-derived joint actions → live relations → knockdown race</p>
          <div class="source-badge" id="source-badge">FINITE-SHOT FIXTURE</div>
        </header>

        <main class="game-layout">
          <section class="arena-column" aria-label="Quantum Royale arena and spectator controls">
            <section class="scoreboard" aria-labelledby="scoreboard-title">
              <div class="scoreboard-heading">
                <div><p class="eyebrow">Live match state</p><h2 id="scoreboard-title">Most knockdowns after Round 4 wins</h2></div>
                <p>Ties: damage dealt → health → qubit identity</p>
              </div>
              <ol class="leaderboard" aria-label="Live chicken health and knockdown standings">${leaderboard}</ol>
            </section>

            <div class="broadcast-grid">
              <div class="arena-frame">
                <div id="game-canvas" aria-label="Six autonomous pixel chickens battling in the arena"></div>
                <div class="arena-status">
                  <strong id="arena-round">ROUND 1 / 4</strong>
                  <span id="arena-clock">45.0s</span>
                  <span id="arena-score">LEADER · 0 KO</span>
                  <span id="arena-phase" role="status" aria-live="polite" aria-atomic="true">READY</span>
                </div>
                <p class="win-condition">MOST KNOCKDOWNS WINS</p>
                <section id="start-gate" class="start-gate" aria-labelledby="start-title">
                  <p class="eyebrow">Spectator briefing</p>
                  <h2 id="start-title" tabindex="-1">Choose a chicken. Follow the relations.</h2>
                  <p>Six chickens compete for the most knockdowns across four rounds. Between rounds, you may bet fictional points on the eventual winner.</p>
                  <p>Classical proximity opens an encounter. A stored quantum-derived pair distribution supplies both chickens' actions; ordinary game rules apply the consequence.</p>
                  <p>No quantum computer, simulator, Python process, or provider is contacted during play.</p>
                  <div class="start-actions">
                    <button id="start-match" class="primary-control" type="button">Start match · 1×</button>
                    <button id="start-open-lab" type="button">Open technical lab</button>
                  </div>
                </section>

                <section id="intermission" class="intermission" hidden aria-labelledby="intermission-title">
                  <p class="eyebrow" id="intermission-kicker">Relationship checkpoint loaded</p>
                  <h2 id="intermission-title" tabindex="-1">Round complete</h2>
                  <p id="branch-explanation"></p>
                  <div class="checkpoint-chain" aria-label="Checkpoint selection chain">
                    <span id="checkpoint-chain-resolver">RESOLVER #—</span>
                    <i aria-hidden="true">→</i>
                    <span id="checkpoint-chain-outcome">OUTCOME —</span>
                    <i aria-hidden="true">→</i>
                    <span id="checkpoint-chain-branch">BRANCH —</span>
                    <i aria-hidden="true">→</i>
                    <span id="checkpoint-chain-operation">GATE —</span>
                    <i aria-hidden="true">→</i>
                    <strong id="checkpoint-chain-child">CHECKPOINT —</strong>
                  </div>
                  <p class="offline-note">The child circuit and tomography were computed offline before play.</p>
                  <div id="bet-form" class="bet-form">
                    <p class="bet-heading"><strong>PICK THE MATCH WINNER</strong><span>Most knockdowns after Round 4 wins.</span></p>
                    <div class="winner-grid" role="group" aria-label="Choose the match winner">${winnerButtons}</div>
                    <div class="stake-buttons" role="group" aria-label="Choose point stake">
                      <button type="button" data-bet-stake="5" aria-pressed="false">5</button>
                      <button type="button" data-bet-stake="10" aria-pressed="true">10</button>
                      <button type="button" data-bet-stake="25" aria-pressed="false">25</button>
                      <button type="button" data-bet-stake="all" aria-pressed="false">ALL</button>
                    </div>
                    <button id="place-bet" class="primary-control" type="button">Bet 10 on Velvet Talon</button>
                    <button id="skip-bet" type="button">Skip this intermission</button>
                  </div>
                  <p id="bet-decision" class="bet-decision"></p>
                  <button id="continue-match" class="continue-control" type="button" disabled>Continue to next round</button>
                </section>

                <section id="result-card" class="intermission result-card" hidden aria-labelledby="result-title">
                  <p class="eyebrow">Four rounds complete</p>
                  <h2 id="result-title" tabindex="-1">Winner</h2>
                  <p id="result-ranking" class="result-ranking"></p>
                  <p id="result-decision" class="result-decision"></p>
                  <p id="result-pair" class="result-pair"></p>
                  <div class="operation-card">
                    <span>Final ticket calculation</span>
                    <strong id="result-payout">—</strong>
                    <small>Each winning ticket returns exactly 6× its stake, including the stake.</small>
                  </div>
                  <section id="interview-deck" class="interview-deck" aria-labelledby="interview-name">
                    <div class="interview-meta"><span id="interview-progress">Interview 1 / 6</span><span>deterministic post-match interpretation</span></div>
                    <h3 id="interview-name">Post-match interview</h3>
                    <p id="interview-identity" class="interview-identity">—</p>
                    <p id="interview-trace">—</p>
                    <blockquote id="interview-lines"></blockquote>
                    <details id="interview-source-details" class="interview-source-details"><summary>Open source-event trace</summary><p id="interview-sources" class="interview-sources">—</p></details>
                    <div class="interview-controls">
                      <button id="previous-interview" type="button">Previous</button>
                      <button id="next-interview" type="button">Next</button>
                      <button id="skip-interviews" type="button">Collapse interviews</button>
                    </div>
                  </section>
                  <button id="restart-result" class="primary-control" type="button">Run same seed again</button>
                </section>
              </div>

              <aside class="presenter-column" aria-label="Presenter close-up and explicit round pauses">
                <section id="presenter-live" class="presenter-live">
                  <div class="tracking-controls">
                    <span>COOP-CAM TRACKS</span>
                    <div role="group" aria-label="Choose a chicken for the presenter camera">${trackingButtons}</div>
                  </div>
                  <div class="relation-legend" aria-label="Active relation legend">
                    <span class="relation-x">X · COMBAT</span>
                    <span class="relation-y">Y · PROTECTION</span>
                    <span class="relation-z">Z · MOVEMENT</span>
                    <span class="relation-observed">BLUE · OBSERVED</span>
                    <span class="relation-global">GREY · OTHER ACTIVE</span>
                    <span class="relation-tracked">GOLD · TRACKED</span>
                  </div>
                  <p class="relation-legend-note">Lines show sampled relations whose presentation window is still active—not proximity or permanent partnerships.</p>
                  <div class="presenter-screen">
                    <canvas id="presenter-canvas" width="256" height="192" aria-label="Read-only close-up of the current relationship event"></canvas>
                    <span class="screen-label">COOP-CAM · READ-ONLY FRAME PACKET</span>
                    <p id="presenter-caption" class="presenter-caption">WAITING FOR THE FIRST AUTHORIZED PAIR EVENT</p>
                  </div>
                  <div id="desk-slot"></div>
                </section>
                <div id="pause-slot" class="pause-slot"></div>
              </aside>
            </div>

            <section id="instrument-slot" class="instrument-slot" aria-label="Exact live quantum relationship resolver">
              <section class="tech-section live-resolver">
                <div class="section-heading">
                  <div><p class="eyebrow">Exact resolver event</p><h3 id="trace-context">Awaiting interaction</h3></div>
                  <span id="trace-event-id" class="event-chip">—</span>
                </div>
                <p class="instrument-chain">STORED JOINT DISTRIBUTION → BROWSER SAMPLE → ACTIONS</p>
                <p class="instrument-state"><span id="instrument-checkpoint">CHECKPOINT —</span><span id="instrument-branch">ROOT · NO BRANCH YET</span></p>
                <p id="trace-pair" class="pair-line">Ordered pair —</p>
                <div class="probability-stack" aria-label="Four joint action probabilities">
                  ${probabilityRows}
                  <div class="cumulative-readout" aria-label="Recorded draw crossing the cumulative joint distribution">
                    <span>0</span>
                    <div class="cumulative-track">${cumulativeSegments}<i id="cumulative-draw-marker" title="Recorded PRNG draw"></i></div>
                    <span>1</span>
                  </div>
                </div>
                <dl class="trace-grid">
                  <div><dt>PRNG draw</dt><dd id="trace-draw">—</dd></div>
                  <div><dt>Outcome</dt><dd id="trace-outcome">—</dd></div>
                  <div><dt>Actions</dt><dd id="trace-actions">—</dd></div>
                  <div><dt>Reason</dt><dd id="trace-reason">—</dd></div>
                </dl>
                <p id="trace-consequence" class="consequence-line">The same event will drive animation, state, score, and this readout.</p>
                <p id="trace-spotlight" class="spotlight-line">Spotlight not yet resolved.</p>
                <p id="sound-audit" class="sound-audit">SOUND LOCKED UNTIL START</p>
              </section>
            </section>

            <section id="analysis-desk" class="analysis-desk" aria-label="Deterministic two-chicken analysis desk">
              <div class="desk-cast" aria-hidden="true">
                <img src="${assetBase}assets/pixel/commentators/clive-peckham.png" alt="" />
                <img src="${assetBase}assets/pixel/commentators/henrietta-hype.png" alt="" />
              </div>
              <div class="desk-copy">
                <p class="eyebrow">The Coop Desk · global coverage</p>
                <p id="desk-line" class="desk-line" aria-live="polite"><strong>CLIVE PECKHAM</strong> Waiting for the first globally significant event.</p>
                <ol id="desk-insights" class="desk-insights"></ol>
              </div>
            </section>

            <p class="pair-explainer"><strong>THREE-PART CAUSAL KEY:</strong><span>1 · Classical proximity opens an encounter.</span><span>2 · The stored pair distribution supplies two joint actions.</span><span>3 · Classical rules apply health, shield, movement, and score consequences.</span></p>

            <nav class="spectator-controls" aria-label="Spectator controls">
              <div class="speed-control" role="group" aria-label="Match speed">
                <span>SIM SPEED</span>
                <button type="button" data-speed="1" aria-pressed="true">1×</button>
                <button type="button" data-speed="2" aria-pressed="false">2×</button>
                <button type="button" data-speed="4" aria-pressed="false">4×</button>
              </div>
              <button id="pause-match" type="button">Pause</button>
              <button id="restart-match" type="button">Restart same seed</button>
              <button id="mute-sound" type="button" aria-pressed="false">Sound on</button>
              <label class="volume-control">VOL <input id="sound-volume" type="range" min="0" max="1" step="0.05" value="0.35" /></label>
              <span id="control-status" role="status">Spectator inputs never choose actions or targets.</span>
            </nav>
          </section>

          <details id="lab-panel" class="technical-panel" aria-label="Detailed technical machinery">
            <summary><span>LAB</span><strong>Open technical basis</strong><small>pipeline · circuit · provenance · audit</small></summary>
            <div class="lab-content">
              <section class="lab-group" aria-labelledby="pipeline-title">
                <div class="lab-group-heading"><p class="eyebrow">01 · Pipeline</p><h2 id="pipeline-title">From circuit to consequence</h2></div>
                <ol class="causal-pipeline">
                  <li>Author one six-qubit circuit.</li>
                  <li>Characterize all K6 pairs offline with QuantumGraph and finite-shot pairwise tomography.</li>
                  <li>Let classical movement, injury, availability, and proximity open an encounter.</li>
                  <li>Read that ordered pair's stored X, Y, or Z distribution.</li>
                  <li>Make and record one classical browser draw.</li>
                  <li>Map the joint outcome to two actions.</li>
                  <li>Apply ordinary movement, shield, health, and scoring rules.</li>
                  <li>Use one spotlight outcome to select a precomputed checkpoint branch.</li>
                </ol>
                <p class="offline-boundary"><strong>Runtime boundary:</strong> no QPU, Aer simulator, Python process, provider, or Moth API is contacted during play.</p>
                <section class="telemetry-grid" aria-label="Live simulation telemetry">
                  <div><span>ROUND / TICK</span><strong id="tech-tick">1 · 0</strong></div>
                  <div><span>SEED / SPEED</span><strong id="tech-seed">—</strong></div>
                  <div class="wide"><span>CHECKPOINT</span><strong id="tech-checkpoint">—</strong></div>
                  <div><span>DELIVERY</span><strong>COMMITTED FIXTURE</strong></div>
                  <div><span>ACQUISITION</span><strong id="tech-source">FINITE-SHOT AER</strong></div>
                </section>
              </section>

              <section class="lab-group" aria-labelledby="circuit-title">
                <div class="lab-group-heading"><p class="eyebrow">02 · Circuit + checkpoints</p><h2 id="circuit-title">K6 relation field and branch tree</h2></div>
                <div class="lab-two-column">
                  <section class="tech-section">
                    <div class="section-heading"><div><p class="eyebrow">Six-node relation field</p><h3>Graph + branch state</h3></div><span class="event-chip">K6 · 15</span></div>
                    <p id="graph-state">All 15 encounter pairs have direct fitted pair states.</p>
                    <p id="branch-rule"><strong>++ / -- → MATCHED_ACTION; +- / -+ → SPLIT_ACTION</strong></p>
                    <p id="branch-state">No branch selected yet.</p>
                  </section>
                  <section class="tech-section provenance-section">
                    <p class="eyebrow">Current circuit</p>
                    <h3 id="provenance-circuit">Circuit —</h3>
                    <ol id="operation-history" class="operation-history"></ol>
                  </section>
                </div>
                <section class="relation-heatmap" aria-labelledby="heatmap-title">
                  <p class="eyebrow">Pair-state change from parent checkpoint</p>
                  <h3 id="heatmap-title">Pair distributions changed</h3>
                  <div id="checkpoint-heatmap" class="heatmap-grid" aria-label="Six by six matrix of pair distribution changes"></div>
                  <p id="heatmap-legend" class="heatmap-legend">Darker cells changed more in this spotlight context.</p>
                </section>
              </section>

              <section class="lab-group" aria-labelledby="provenance-title">
                <div class="lab-group-heading"><p class="eyebrow">03 · Provenance + limits</p><h2 id="provenance-title">What was computed—and what is not claimed</h2></div>
                <div class="lab-two-column">
                  <section class="tech-section provenance-section">
                    <p class="eyebrow">Artifact provenance</p>
                    <dl class="provenance-grid">
                      <div><dt>Fixture</dt><dd id="provenance-fixture">${this.bank.fixtureBankId}</dd></div>
                      <div><dt>Shots</dt><dd id="provenance-shots">—</dd></div>
                      <div><dt>Tomography</dt><dd>15 circuits/checkpoint</dd></div>
                      <div><dt>QuantumGraph</dt><dd id="provenance-qg">—</dd></div>
                      <div><dt>Pairwise tomo</dt><dd id="provenance-pt">—</dd></div>
                    </dl>
                  </section>
                  <section class="tech-section limits-section">
                    <p class="eyebrow">Claim boundary</p>
                    <ul>
                      <li>Quantum-derived data supplies basis-dependent pair distributions, not punches, dialogue, or personalities.</li>
                      <li>Pairwise tomography does not establish entanglement or a coherent semantic social graph.</li>
                      <li>The same physical qubits do not persist through the browser match.</li>
                      <li>This prototype demonstrates no quantum speedup, advantage, or hardware feasibility.</li>
                    </ul>
                  </section>
                </div>
                <section class="tech-section code-readout">
                  <div class="section-heading">
                    <div><p class="eyebrow">Checked-in execution source</p><h3 id="code-title">selectOutcome()</h3></div>
                    <div class="code-tabs" role="group" aria-label="Execution source">
                      <button type="button" data-code="sampling" aria-pressed="true">Draw</button>
                      <button type="button" data-code="meaning" aria-pressed="false">Meaning</button>
                    </div>
                  </div>
                  <p id="code-module" class="module-path"></p>
                  <pre id="execution-code" tabindex="0"></pre>
                  <p class="current-call"><span>Current arguments</span><code id="current-call">waiting for event</code></p>
                </section>
              </section>

              <section class="lab-group" aria-labelledby="audit-title">
                <div class="lab-group-heading"><p class="eyebrow">04 · Audit + classical control</p><h2 id="audit-title">Reconstruct or challenge the run</h2></div>
                <section class="tech-section diagnostic-section">
                  <div class="section-heading"><div><p class="eyebrow">Current resolver counterfactual</p><h3>Product-of-marginals comparison</h3></div><span id="comparison-event" class="event-chip">AWAITING EVENT</span></div>
                  <p>Preserve each chicken's individual + rate, remove pair covariance, and evaluate the same recorded draw. This is a diagnostic—not an advantage claim.</p>
                  <button id="compare-current-event" type="button" disabled>Compare current resolver event</button>
                  <div id="pair-comparison" class="pair-comparison" aria-live="polite"><p>No resolver event is available yet.</p></div>
                </section>
                <details id="history-details" class="tech-section history-section">
                  <summary><span>Consequential audit history</span><strong id="history-count">0 events</strong></summary>
                  <div class="history-controls">
                    <label>Round<select id="history-round"><option value="all">All</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
                    <label>Chicken<select id="history-chicken"><option value="all">All</option>${chickenFilterOptions}</select></label>
                    <label>Pair<select id="history-pair"><option value="all">All</option>${pairFilterOptions}</select></label>
                    <label>Context<select id="history-context"><option value="all">All</option><option value="X">X combat</option><option value="Y">Y protection</option><option value="Z">Z movement</option></select></label>
                    <label>Event<select id="history-kind"><option value="all">All</option><option value="interaction">Interactions</option><option value="branch">Branch events</option><option value="knockdown">Knockdowns</option><option value="commentary">Commentary</option></select></label>
                    <button id="export-audit" type="button">Download complete JSON</button>
                  </div>
                  <p id="history-filter-result" class="history-filter-result">Open the audit to render events.</p>
                  <ol id="event-history" tabindex="0" aria-label="Filtered consequential event history"></ol>
                </details>
              </section>
            </div>
          </details>
        </main>
      </div>`;
  }

  private bindControls(): void {
    required<HTMLButtonElement>(this.root, "#start-match").addEventListener(
      "click",
      () => {
        this.simulation.setSpeed(1);
        this.started = true;
        this.simulation.setPaused(false);
        required<HTMLElement>(this.root, "#start-gate").hidden = true;
        void this.sound
          .unlock()
          .then(() => {
            required<HTMLElement>(this.root, "#sound-audit").textContent =
              "SOUND READY · EVENT-BOUND EFFECTS ONLY";
          })
          .catch(() => {
            required<HTMLElement>(this.root, "#sound-audit").textContent =
              "SOUND UNAVAILABLE · VISIBLE EVENT CUES REMAIN";
          });
        this.setStatus(
          "Match started at 1×. Spectator controls remain presentation-only.",
        );
      },
    );
    required<HTMLButtonElement>(this.root, "#start-open-lab").addEventListener(
      "click",
      () => this.openLab(),
    );
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-speed]",
    )) {
      button.addEventListener("click", () => {
        const speed = Number(button.dataset.speed);
        if (speed !== 1 && speed !== 2 && speed !== 4) return;
        this.simulation.setSpeed(speed);
        this.setStatus(`Simulation and animation throughput set to ${speed}×.`);
      });
    }
    required<HTMLButtonElement>(this.root, "#pause-match").addEventListener(
      "click",
      () => {
        this.simulation.togglePaused();
      },
    );
    required<HTMLButtonElement>(this.root, "#mute-sound").addEventListener(
      "click",
      (event) => {
        const muted = !this.sound.isMuted();
        this.sound.setMuted(muted);
        const button = event.currentTarget as HTMLButtonElement;
        button.textContent = muted ? "Sound off" : "Sound on";
        button.setAttribute("aria-pressed", String(muted));
      },
    );
    required<HTMLInputElement>(this.root, "#sound-volume").addEventListener(
      "input",
      (event) => {
        this.sound.setVolume(
          Number((event.currentTarget as HTMLInputElement).value),
        );
      },
    );
    const restart = (): void => {
      this.pairComparison = null;
      this.historyRenderKey = "";
      this.interviewIndex = 0;
      this.interviewsSkipped = false;
      this.started = false;
      const resetPacket = this.simulation.restart();
      this.simulation.setPaused(true);
      this.options.onExternalPacket(
        Object.freeze({
          snapshot: this.simulation.getSnapshot(),
          events: resetPacket.events,
        }),
      );
      this.setStatus("Same seed reset at tick 0. Start when ready.");
    };
    required<HTMLButtonElement>(this.root, "#restart-match").addEventListener(
      "click",
      restart,
    );
    required<HTMLButtonElement>(this.root, "#restart-result").addEventListener(
      "click",
      restart,
    );
    required<HTMLButtonElement>(
      this.root,
      "#previous-interview",
    ).addEventListener("click", () => {
      this.interviewsSkipped = false;
      this.interviewIndex = Math.max(0, this.interviewIndex - 1);
      if (this.latestSnapshot) this.renderInterviews(this.latestSnapshot);
    });
    required<HTMLButtonElement>(this.root, "#next-interview").addEventListener(
      "click",
      () => {
        this.interviewsSkipped = false;
        const count = this.latestSnapshot?.interviews.length ?? 0;
        this.interviewIndex = Math.min(
          Math.max(0, count - 1),
          this.interviewIndex + 1,
        );
        if (this.latestSnapshot) this.renderInterviews(this.latestSnapshot);
      },
    );
    required<HTMLButtonElement>(this.root, "#skip-interviews").addEventListener(
      "click",
      () => {
        this.interviewsSkipped = !this.interviewsSkipped;
        if (this.latestSnapshot) this.renderInterviews(this.latestSnapshot);
      },
    );

    required<HTMLButtonElement>(this.root, "#place-bet").addEventListener(
      "click",
      () => {
        this.runControlAction(() => {
          this.simulation.placeBet(
            this.selectedBetChickenId,
            this.selectedBetStake,
          );
          this.setStatus(
            `Ticket placed on ${chickenName(this.selectedBetChickenId)}.`,
          );
        });
      },
    );
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-bet-chicken]",
    )) {
      button.addEventListener("click", () => {
        const id = button.dataset.betChicken;
        if (!isChickenId(id)) return;
        this.selectedBetChickenId = id;
        if (this.latestSnapshot) this.renderBetChoices(this.latestSnapshot);
      });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-bet-stake]",
    )) {
      button.addEventListener("click", () => {
        const value = button.dataset.betStake;
        const remaining = this.latestSnapshot?.bets.remainingPoints ?? 100;
        this.selectedBetStake =
          value === "all" ? remaining : Math.min(remaining, Number(value));
        if (this.latestSnapshot) this.renderBetChoices(this.latestSnapshot);
      });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-track-chicken]",
    )) {
      button.addEventListener("click", () => {
        const id = button.dataset.trackChicken;
        if (!isChickenId(id)) return;
        this.trackedChickenId = id;
        this.presenter.setTrackedChicken(id);
        this.renderTrackingChoice();
        if (this.latestSnapshot) {
          const focus = this.presenter.render({
            snapshot: this.latestSnapshot,
            events: [],
          });
          this.options.onPresentationFocus(focus, this.latestSnapshot);
        }
        this.setStatus(`Coop-Cam now follows ${chickenName(id)}.`);
      });
    }
    required<HTMLButtonElement>(this.root, "#skip-bet").addEventListener(
      "click",
      () => {
        this.runControlAction(() => {
          this.simulation.skipBet();
          this.setStatus("No new ticket this intermission.");
        });
      },
    );
    required<HTMLButtonElement>(this.root, "#continue-match").addEventListener(
      "click",
      () => {
        this.runControlAction(() => this.simulation.continueFromIntermission());
      },
    );

    required<HTMLButtonElement>(
      this.root,
      "#compare-current-event",
    ).addEventListener("click", () => {
      this.runControlAction(() => {
        const event = this.currentResolverEvent();
        if (!event) throw new Error("No resolver event is available yet.");
        this.pairComparison = comparePairEventToProductControl(
          this.bank,
          event,
        );
        this.renderPairComparison();
      });
    });

    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-code]",
    )) {
      button.addEventListener("click", () => {
        const key = button.dataset.code;
        if (key !== "sampling" && key !== "meaning") return;
        this.showCode(key);
      });
    }
    for (const [selector, key] of [
      ["#history-round", "round"],
      ["#history-chicken", "chicken"],
      ["#history-pair", "pair"],
      ["#history-context", "context"],
      ["#history-kind", "kind"],
    ] as const) {
      required<HTMLSelectElement>(this.root, selector).addEventListener(
        "change",
        (event) => {
          Object.assign(this.historyFilters, {
            [key]: (event.currentTarget as HTMLSelectElement).value,
          });
          this.historyRenderKey = "";
          if (this.latestSnapshot) this.renderHistory(this.latestSnapshot);
        },
      );
    }
    required<HTMLDetailsElement>(
      this.root,
      "#history-details",
    ).addEventListener("toggle", () => {
      this.historyRenderKey = "";
      if (this.latestSnapshot) this.renderHistory(this.latestSnapshot);
    });
    required<HTMLButtonElement>(this.root, "#export-audit").addEventListener(
      "click",
      () => {
        if (this.latestSnapshot) this.exportAudit(this.latestSnapshot);
      },
    );
    this.showCode("sampling");
    this.renderTrackingChoice();
  }

  private renderMatchHeader(snapshot: MatchSnapshot): void {
    const remaining = Math.max(
      0,
      TUNING.roundSeconds - snapshot.roundTick / TUNING.ticksPerSecond,
    );
    required<HTMLElement>(this.root, "#arena-round").textContent =
      `ROUND ${snapshot.round} / 4`;
    required<HTMLElement>(this.root, "#arena-clock").textContent =
      snapshot.phase === "round"
        ? `${remaining.toFixed(1)}s`
        : snapshot.phase.toUpperCase();
    const leader = [...snapshot.chickens].sort(
      (left, right) =>
        right.knockdowns - left.knockdowns ||
        (CHICKEN_BY_ID.get(left.id)?.qubit ?? 0) -
          (CHICKEN_BY_ID.get(right.id)?.qubit ?? 0),
    )[0];
    required<HTMLElement>(this.root, "#arena-score").textContent = leader
      ? `LEADER ${CHICKEN_BY_ID.get(leader.id)?.shortName.toUpperCase() ?? leader.id} · ${leader.knockdowns} KO`
      : "LEADER · 0 KO";
    const phaseText = !this.started
      ? "READY"
      : snapshot.paused
        ? "PAUSED"
        : snapshot.phase === "round"
          ? "LIVE"
          : snapshot.phase === "intermission"
            ? "BETTING PAUSE"
            : "FINAL";
    const phase = required<HTMLElement>(this.root, "#arena-phase");
    if (phase.textContent !== phaseText) phase.textContent = phaseText;
    required<HTMLElement>(this.root, "#tech-tick").textContent =
      `${snapshot.round} · ${snapshot.roundTick}/${snapshot.roundTicks}`;
    required<HTMLElement>(this.root, "#tech-seed").textContent =
      `${snapshot.seed} · ${snapshot.speed}×`;
    required<HTMLElement>(this.root, "#tech-checkpoint").textContent =
      snapshot.activeCheckpointId;
    required<HTMLElement>(this.root, "#instrument-checkpoint").textContent =
      `CHECKPOINT ${snapshot.activeCheckpointId}`;
    required<HTMLElement>(this.root, "#tech-source").textContent =
      snapshot.resolverMode === "quantum"
        ? this.acquisitionLabel()
        : "CLASSICAL PRODUCT CONTROL";

    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-speed]",
    )) {
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.speed) === snapshot.speed),
      );
    }
    const pause = required<HTMLButtonElement>(this.root, "#pause-match");
    pause.textContent = snapshot.paused ? "Resume" : "Pause";
    pause.disabled = !this.started || snapshot.phase !== "round";
  }

  private renderLeaderboard(snapshot: MatchSnapshot): void {
    for (const chicken of snapshot.chickens) {
      const card = required<HTMLElement>(
        this.root,
        `[data-chicken-card="${chicken.id}"]`,
      );
      card.classList.toggle("is-down", chicken.isDown);
      card.classList.toggle("is-shielded", chicken.shield > 0);
      required<HTMLElement>(card, "[data-public-name]").textContent =
        chickenName(chicken.id);
      required<HTMLElement>(card, "[data-health]").textContent =
        `${formatNumber(chicken.health, 1)} / ${formatNumber(chicken.maxHealth, 1)} HP`;
      required<HTMLElement>(card, "[data-score]").textContent = String(
        chicken.knockdowns,
      );
      required<HTMLElement>(card, "[data-state]").textContent = chicken.isDown
        ? "DOWN"
        : chicken.isInvulnerable
          ? "RECOVERING"
          : "UP";
      const healthBar = required<HTMLElement>(card, "[data-health-bar]");
      healthBar.setAttribute("aria-valuemax", String(chicken.maxHealth));
      healthBar.setAttribute("aria-valuenow", String(chicken.health));
      healthBar.setAttribute(
        "aria-valuetext",
        `${formatNumber(chicken.health, 1)} of ${formatNumber(chicken.maxHealth, 1)} health${chicken.isDown ? ", down" : ""}`,
      );
      required<HTMLElement>(card, "[data-health-fill]").style.width =
        `${Math.max(0, Math.min(100, (chicken.health / chicken.maxHealth) * 100))}%`;
      const shield = required<HTMLElement>(card, "[data-shield]");
      shield.hidden = chicken.shield <= 0;
      required<HTMLElement>(card, "[data-shield-text]").textContent =
        formatNumber(chicken.shield, 1);
      required<HTMLElement>(card, "[data-shield-fill]").style.width =
        `${Math.max(0, Math.min(100, (chicken.shield / 6) * 100))}%`;
    }
    this.renderBetChoices(snapshot);
  }

  private renderCommentary(snapshot: MatchSnapshot): void {
    const line = required<HTMLElement>(this.root, "#desk-line");
    const selection = selectGlobalCommentary(snapshot);
    const latest = selection.latest;
    if (latest) {
      const speaker =
        latest.speaker === "clive-peckham" ? "CLIVE PECKHAM" : "HENRIETTA HYPE";
      line.replaceChildren();
      const label = document.createElement("strong");
      label.textContent = speaker;
      line.append(label, document.createTextNode(` ${latest.text}`));
      line.dataset.sourceEvents = latest.sourceEventIds.join(",");
    } else {
      line.innerHTML =
        "<strong>CLIVE PECKHAM</strong> Waiting for the first globally significant event.";
      delete line.dataset.sourceEvents;
    }
    const insights = required<HTMLOListElement>(this.root, "#desk-insights");
    insights.replaceChildren();
    for (const event of selection.intermissionInsights) {
      const item = document.createElement("li");
      item.textContent = event.text;
      item.dataset.sourceEvents = event.sourceEventIds.join(",");
      insights.append(item);
    }
  }

  private renderTrackingChoice(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-track-chicken]",
    )) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.trackChicken === this.trackedChickenId),
      );
    }
  }

  private renderBetChoices(snapshot: MatchSnapshot): void {
    const remaining = snapshot.bets.remainingPoints;
    if (remaining > 0 && this.selectedBetStake > remaining)
      this.selectedBetStake = remaining;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-bet-chicken]",
    )) {
      const id = button.dataset.betChicken;
      button.setAttribute(
        "aria-pressed",
        String(id === this.selectedBetChickenId),
      );
      if (!isChickenId(id)) continue;
      const chicken = snapshot.chickens.find(
        (candidate) => candidate.id === id,
      );
      const score = button.querySelector<HTMLElement>("[data-bet-score]");
      if (score)
        score.textContent = `${chicken?.knockdowns ?? 0} knockdown${chicken?.knockdowns === 1 ? "" : "s"}`;
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-bet-stake]",
    )) {
      const raw = button.dataset.betStake;
      const value = raw === "all" ? remaining : Number(raw);
      button.setAttribute(
        "aria-pressed",
        String(value === this.selectedBetStake),
      );
      button.disabled = remaining < 1 || (raw !== "all" && value > remaining);
    }
    required<HTMLButtonElement>(this.root, "#place-bet").textContent =
      `Bet ${this.selectedBetStake} on ${chickenName(this.selectedBetChickenId)}`;
  }

  private renderTechnicalTrace(snapshot: MatchSnapshot): void {
    const event = this.currentResolverEvent();
    const compareButton = required<HTMLButtonElement>(
      this.root,
      "#compare-current-event",
    );
    if (!event) {
      compareButton.disabled = true;
      return;
    }
    compareButton.disabled = false;
    required<HTMLElement>(this.root, "#comparison-event").textContent =
      `EVENT #${event.eventId}`;
    if (
      this.pairComparison &&
      this.pairComparison.sourceEventId !== event.eventId
    ) {
      this.pairComparison = null;
    }
    const branchResolver =
      snapshot.phase === "intermission"
        ? snapshot.branchHistory.at(-1)?.resolverEvent
        : null;
    const isBranchCause = branchResolver?.eventId === event.eventId;
    const eventIsCurrent =
      event.round === snapshot.round &&
      event.checkpointId === snapshot.activeCheckpointId;
    required<HTMLElement>(this.root, "#trace-context").textContent =
      isBranchCause
        ? `BRANCH CAUSE · ${CONTEXT_LABELS[event.context]}`
        : eventIsCurrent
          ? CONTEXT_LABELS[event.context]
          : `LAST ROUND · ${CONTEXT_LABELS[event.context]}`;
    required<HTMLElement>(this.root, "#trace-event-id").textContent =
      `EVENT #${event.eventId}`;
    required<HTMLElement>(this.root, "#trace-pair").textContent =
      `Ordered pair A/B: ${chickenName(event.orderedPair[0])} (q${event.qubits[0]}) → ${chickenName(event.orderedPair[1])} (q${event.qubits[1]}) · ${event.checkpointId}`;
    for (const key of ["pp", "pm", "mp", "mm"] as const) {
      const row = required<HTMLElement>(
        this.root,
        `[data-probability="${key}"]`,
      );
      const probability = event.probabilities[key];
      required<HTMLElement>(row, ".probability-fill").style.width =
        `${probability * 100}%`;
      required<HTMLElement>(row, ".probability-value").textContent =
        `${(probability * 100).toFixed(2)}%`;
      row.classList.toggle("is-selected", key === event.jointOutcome);
      const segment = required<HTMLElement>(
        this.root,
        `[data-cumulative="${key}"]`,
      );
      segment.style.width = `${probability * 100}%`;
      segment.classList.toggle("is-selected", key === event.jointOutcome);
    }
    required<HTMLElement>(this.root, "#cumulative-draw-marker").style.left =
      `${event.prngDraw * 100}%`;
    required<HTMLElement>(this.root, "#trace-draw").textContent =
      event.prngDraw.toFixed(8);
    required<HTMLElement>(this.root, "#trace-outcome").textContent =
      OUTCOME_LABELS[event.jointOutcome];
    required<HTMLElement>(this.root, "#trace-actions").textContent =
      `${event.actions.a} / ${event.actions.b}`;
    required<HTMLElement>(this.root, "#trace-reason").textContent =
      INTERACTION_REASON_LABELS[event.reason];
    required<HTMLElement>(this.root, "#trace-consequence").textContent =
      describeConsequences(event);
    required<HTMLElement>(this.root, "#trace-spotlight").textContent = event
      .spotlight.selected
      ? `${event.spotlight.branchLabel} → ${event.spotlight.pendingChildId}. The child was compiled offline; no circuit ran now.`
      : event.spotlight.eligible
        ? "Spotlight eligible, but no child was selected."
        : "This event did not select a branch.";
    required<HTMLElement>(this.root, "#current-call").textContent =
      JSON.stringify({
        checkpointId: event.checkpointId,
        orderedPair: event.orderedPair,
        context: event.context,
        probabilities: event.probabilities,
        draw: event.prngDraw,
        outcome: event.jointOutcome,
      });
  }

  private currentResolverEvent(): InteractionResolvedEvent | null {
    const snapshot = this.latestSnapshot;
    if (!snapshot) return null;
    return snapshot.phase === "intermission"
      ? (snapshot.branchHistory.at(-1)?.resolverEvent ??
          snapshot.latestInteraction)
      : snapshot.latestInteraction;
  }

  private renderCheckpoint(snapshot: MatchSnapshot): void {
    const checkpoint = this.requireCheckpoint(snapshot.activeCheckpointId);
    this.renderRelationshipHeatmap(checkpoint);
    const latest = snapshot.latestInteraction;
    const activeInteraction =
      latest?.round === snapshot.round &&
      latest.checkpointId === snapshot.activeCheckpointId
        ? latest
        : null;
    const spotlightPair = checkpoint.spotlight.orderedPair
      .map(qubitName)
      .join(" ↔ ");
    const activePair = activeInteraction
      ? activeInteraction.orderedPair.map(chickenName).join(" ↔ ")
      : "none in this checkpoint yet";
    required<HTMLElement>(this.root, "#graph-state").textContent =
      `Direct fitted K6 pairs: 15. Spotlight: ${spotlightPair}, ${CONTEXT_LABELS[checkpoint.spotlight.context]}. Active edge: ${activePair}.`;
    const latestBranch = snapshot.branchHistory.at(-1);
    const branchPath = snapshot.branchHistory
      .map(
        (entry) =>
          `${entry.branchLabel} ${OUTCOME_LABELS[entry.outcome]} → ${entry.childCheckpointId}`,
      )
      .join(" · ");
    required<HTMLElement>(this.root, "#branch-state").textContent = latestBranch
      ? snapshot.pendingCheckpointId === latestBranch.childCheckpointId
        ? `Full path: ${branchPath}. The newest child remains pending until the round boundary.`
        : `Full path: ${branchPath}. The newest committed checkpoint activated at the round boundary.`
      : `Spotlight window opens at ${checkpoint.spotlight.windowOpensAtSeconds}s; deterministic fallback opportunity at ${checkpoint.spotlight.fallbackDeadlineSeconds}s.`;
    required<HTMLElement>(this.root, "#instrument-branch").textContent =
      latestBranch
        ? `${latestBranch.branchLabel} · ${OUTCOME_LABELS[latestBranch.outcome]} · ${latestBranch.childCheckpointId}`
        : "ROOT · NO BRANCH YET";
    required<HTMLElement>(this.root, "#provenance-circuit").textContent =
      `Circuit ${checkpoint.circuit.sha256.slice(0, 12)}… · depth ${checkpoint.circuit.depth}`;
    required<HTMLElement>(this.root, "#provenance-shots").textContent =
      `${checkpoint.acquisition.shotsPerCircuit.toLocaleString()} × ${checkpoint.acquisition.tomographyCircuitCount}`;
    required<HTMLElement>(this.root, "#provenance-qg").textContent =
      `${this.bank.provenance.packageVersions.quantumgraph ?? "unknown"} · ${this.bank.provenance.quantumGraphCommit.slice(0, 10)}`;
    required<HTMLElement>(this.root, "#provenance-pt").textContent =
      `${this.bank.provenance.packageVersions["pairwise-tomography"] ?? "unknown"} · ${this.bank.provenance.pairwiseTomographyCommit.slice(0, 10)}`;
    const operationList = required<HTMLOListElement>(
      this.root,
      "#operation-history",
    );
    operationList.replaceChildren();
    if (checkpoint.operationHistory.length === 0) {
      const item = document.createElement("li");
      item.textContent =
        "Root preparation circuit; no branch operation appended.";
      operationList.append(item);
    } else {
      for (const operation of checkpoint.operationHistory) {
        const item = document.createElement("li");
        item.textContent = `${operation.gate}(${operation.angleRadians.toFixed(4)}) on q${operation.orderedPair[0]},q${operation.orderedPair[1]} · ${operation.trigger} · observed distributions stored separately`;
        operationList.append(item);
      }
    }
  }

  private renderBetting(snapshot: MatchSnapshot): void {
    const intermission = required<HTMLElement>(this.root, "#intermission");
    const result = required<HTMLElement>(this.root, "#result-card");
    const phaseChanged = snapshot.phase !== this.previousPhase;
    // Explicit pauses replace the live Coop-Cam with the round decision panel.
    // The frozen arena remains visible beside it, so the checkpoint and betting
    // controls do not fall below the desktop fold.
    required<HTMLElement>(this.root, "#presenter-live").hidden =
      snapshot.phase !== "round";
    const previousPhase = this.previousPhase;
    intermission.hidden = snapshot.phase !== "intermission";
    result.hidden = snapshot.phase !== "finished";

    if (snapshot.phase === "intermission") {
      const nextRound = snapshot.round + 1;
      const branch = snapshot.branchHistory.at(-1);
      const checkpoint = this.requireCheckpoint(snapshot.activeCheckpointId);
      required<HTMLElement>(this.root, "#intermission-kicker").textContent =
        `Round ${snapshot.round} complete · relationship checkpoint loaded`;
      required<HTMLElement>(this.root, "#intermission-title").textContent =
        `Round ${nextRound} checkpoint committed`;
      required<HTMLElement>(this.root, "#branch-explanation").textContent =
        branch
          ? `Resolver event #${branch.resolverEvent.eventId} between ${chickenName(branch.resolverEvent.orderedPair[0])} and ${chickenName(branch.resolverEvent.orderedPair[1])} selected the already-characterized child below. The exact distribution and draw remain visible in the resolver.`
          : "The next committed checkpoint is active.";
      const resolver = branch?.resolverEvent;
      required<HTMLElement>(
        this.root,
        "#checkpoint-chain-resolver",
      ).textContent = resolver ? `RESOLVER #${resolver.eventId}` : "RESOLVER —";
      required<HTMLElement>(
        this.root,
        "#checkpoint-chain-outcome",
      ).textContent = resolver
        ? `OUTCOME ${OUTCOME_LABELS[resolver.jointOutcome]}`
        : "OUTCOME —";
      required<HTMLElement>(this.root, "#checkpoint-chain-branch").textContent =
        branch ? branch.branchLabel : "BRANCH —";
      const operation = checkpoint.operationHistory.at(-1);
      required<HTMLElement>(
        this.root,
        "#checkpoint-chain-operation",
      ).textContent = operation
        ? `${operation.gate}(${operation.angleRadians.toFixed(3)}) · q${operation.orderedPair[0]}↔q${operation.orderedPair[1]}`
        : "ROOT CIRCUIT";
      required<HTMLElement>(this.root, "#checkpoint-chain-child").textContent =
        branch?.childCheckpointId ?? snapshot.activeCheckpointId;
      const decided =
        snapshot.bets.tickets.some(
          (ticket) => ticket.afterRound === snapshot.round,
        ) || snapshot.bets.skippedAfterRounds.includes(snapshot.round);
      required<HTMLButtonElement>(this.root, "#place-bet").disabled =
        decided || snapshot.bets.remainingPoints < 1;
      required<HTMLButtonElement>(this.root, "#skip-bet").disabled = decided;
      required<HTMLButtonElement>(this.root, "#continue-match").disabled =
        !decided;
      this.renderBetChoices(snapshot);
      for (const button of this.root.querySelectorAll<HTMLButtonElement>(
        "[data-bet-chicken], [data-bet-stake]",
      )) {
        button.disabled =
          decided ||
          snapshot.bets.remainingPoints < 1 ||
          (button.dataset.betStake !== undefined &&
            button.dataset.betStake !== "all" &&
            Number(button.dataset.betStake) > snapshot.bets.remainingPoints);
      }
      const decision = snapshot.bets.tickets.find(
        (ticket) => ticket.afterRound === snapshot.round,
      );
      required<HTMLElement>(this.root, "#bet-decision").textContent = decision
        ? `Locked: ${decision.stake} points on ${snapshotChickenName(snapshot, decision.chickenId)}.`
        : snapshot.bets.skippedAfterRounds.includes(snapshot.round)
          ? "Locked: no new ticket this intermission."
          : "One optional ticket. Earlier tickets remain active.";
    }

    if (snapshot.phase === "finished" && snapshot.winnerId) {
      const winner = snapshot.chickens.find(
        (chicken) => chicken.id === snapshot.winnerId,
      );
      const runnerUpId = snapshot.ranking[1];
      const runnerUp = snapshot.chickens.find(
        (chicken) => chicken.id === runnerUpId,
      );
      required<HTMLElement>(this.root, "#result-title").textContent =
        `${snapshotChickenName(snapshot, snapshot.winnerId)} wins`;
      required<HTMLElement>(this.root, "#result-ranking").textContent =
        snapshot.ranking
          .map((id, index) => {
            const chicken = snapshot.chickens.find(
              (candidate) => candidate.id === id,
            );
            return `${index + 1}. ${snapshotChickenName(snapshot, id)} · ${chicken?.knockdowns ?? 0} KO`;
          })
          .join(" · ");
      const tieBreak =
        !winner || !runnerUp || winner.knockdowns !== runnerUp.knockdowns
          ? "decided by knockdowns"
          : winner.damageDealt !== runnerUp.damageDealt
            ? `knockdowns tied; damage ${winner.damageDealt.toFixed(1)} to ${runnerUp.damageDealt.toFixed(1)}`
            : winner.health !== runnerUp.health
              ? `knockdowns and damage tied; health ${winner.health.toFixed(1)} to ${runnerUp.health.toFixed(1)}`
              : "knockdowns, damage, and health tied; qubit identity decided the ranking";
      required<HTMLElement>(this.root, "#result-decision").textContent =
        `Winner rule: ${tieBreak}.`;
      const winnerProfile = snapshot.interviews.find(
        (profile) => profile.chickenId === snapshot.winnerId,
      );
      required<HTMLElement>(this.root, "#result-pair").textContent =
        winnerProfile?.strongestPair
          ? `Decisive relation history: ${snapshotChickenName(snapshot, snapshot.winnerId)} met ${snapshotChickenName(snapshot, winnerProfile.strongestPair.partnerId)} ${winnerProfile.strongestPair.interactionCount} times—${winnerProfile.strongestPair.attacks} attacks, ${winnerProfile.strongestPair.covers} covers, and ${winnerProfile.strongestPair.pursuits} approaches.`
          : "The winner formed no sustained pair history.";
      required<HTMLElement>(this.root, "#result-payout").textContent =
        `${snapshot.bets.remainingPoints} + ${snapshot.bets.winningReturn} = ${snapshot.bets.finalPoints} points`;
      this.renderInterviews(snapshot);
    }

    if (phaseChanged) {
      if (snapshot.phase === "intermission") {
        required<HTMLElement>(this.root, "#intermission-title").focus();
      } else if (snapshot.phase === "finished") {
        required<HTMLElement>(this.root, "#result-title").focus();
      } else if (
        snapshot.phase === "round" &&
        (previousPhase === "intermission" || previousPhase === "finished")
      ) {
        required<HTMLButtonElement>(this.root, "#pause-match").focus();
      }
      this.previousPhase = snapshot.phase;
    }
  }

  private renderInterviews(snapshot: MatchSnapshot): void {
    const deck = required<HTMLElement>(this.root, "#interview-deck");
    const profiles = snapshot.interviews;
    const skip = required<HTMLButtonElement>(this.root, "#skip-interviews");
    const previous = required<HTMLButtonElement>(
      this.root,
      "#previous-interview",
    );
    const next = required<HTMLButtonElement>(this.root, "#next-interview");
    const sources = required<HTMLDetailsElement>(
      this.root,
      "#interview-source-details",
    );
    if (profiles.length === 0) {
      deck.hidden = true;
      return;
    }
    skip.textContent = this.interviewsSkipped
      ? "Show interviews"
      : "Collapse interviews";
    if (this.interviewsSkipped) {
      deck.classList.add("is-collapsed");
      required<HTMLElement>(this.root, "#interview-name").textContent =
        "Interviews collapsed";
      required<HTMLElement>(this.root, "#interview-identity").textContent =
        "Show the deck to read all six deterministic match summaries.";
      required<HTMLElement>(this.root, "#interview-trace").textContent =
        "Final roles are classical interpretations of the completed event record.";
      required<HTMLElement>(this.root, "#interview-lines").textContent = "";
      required<HTMLElement>(this.root, "#interview-sources").textContent = "";
      required<HTMLElement>(this.root, "#interview-progress").textContent =
        "Interview deck collapsed";
      sources.hidden = true;
      previous.hidden = true;
      next.hidden = true;
      return;
    }
    deck.classList.remove("is-collapsed");
    sources.hidden = false;
    previous.hidden = false;
    next.hidden = false;
    this.interviewIndex = Math.min(this.interviewIndex, profiles.length - 1);
    const profile = profiles[this.interviewIndex] as CharacterProfile;
    required<HTMLElement>(this.root, "#interview-progress").textContent =
      `Interview ${this.interviewIndex + 1} / ${profiles.length}`;
    required<HTMLElement>(this.root, "#interview-name").textContent =
      profile.publicName;
    required<HTMLElement>(this.root, "#interview-identity").textContent =
      `#${profile.rank} · FINAL READ: ${profile.finalIdentity.label} · ${profile.knockdowns} knockdowns`;
    required<HTMLElement>(this.root, "#interview-trace").textContent =
      `${profile.matchSummary.damageDealt.toFixed(1)} damage dealt · ${profile.matchSummary.damageReceived.toFixed(1)} received · ${profile.matchSummary.shieldsGranted.toFixed(1)} shield granted · ${profile.matchSummary.shieldAbsorbedForOthers.toFixed(1)} supplied shield absorbed · knocked down ${profile.matchSummary.knockdownsReceived} times · actions: ${profile.matchSummary.attacks} attack, ${profile.matchSummary.guards} guard, ${profile.matchSummary.covers} cover, ${profile.matchSummary.approaches} approach, ${profile.matchSummary.withdrawals} withdraw. ${profile.strongestTraceLabel} was the strongest final role signal (${profile.strongestTraceValue.toFixed(1)}).${
        profile.strongestPair
          ? ` Main counterpart: ${chickenName(profile.strongestPair.partnerId)}, ${profile.strongestPair.interactionCount} pair events.`
          : " No qualifying pair history."
      }`;
    const lines = required<HTMLElement>(this.root, "#interview-lines");
    lines.replaceChildren(
      ...profile.interviewLines.flatMap((text, index) => [
        document.createTextNode(text),
        ...(index < profile.interviewLines.length - 1
          ? [document.createElement("br")]
          : []),
      ]),
    );
    const roleSourceIds = profile.roleHistory.flatMap(
      (entry) => entry.trace.sourceEventIds,
    );
    const pairSourceIds = profile.strongestPair?.sourceEventIds ?? [];
    required<HTMLElement>(this.root, "#interview-sources").textContent =
      `Sources: role evaluations ${summarizeEventIds(profile.roleHistory.map((entry) => entry.evaluationEventId))}; behavioral and pair events ${summarizeEventIds([...roleSourceIds, ...pairSourceIds])}. Full source list in LAB.`;
    previous.disabled = this.interviewIndex === 0;
    next.disabled = this.interviewIndex === profiles.length - 1;
  }

  private renderHistory(snapshot: MatchSnapshot): void {
    const details = required<HTMLDetailsElement>(this.root, "#history-details");
    required<HTMLElement>(this.root, "#history-count").textContent =
      `${snapshot.auditHistory.length} event${snapshot.auditHistory.length === 1 ? "" : "s"}`;
    if (!details.open) {
      required<HTMLElement>(this.root, "#history-filter-result").textContent =
        "Open the audit to filter and render events.";
      return;
    }
    const renderKey = JSON.stringify({
      length: snapshot.auditHistory.length,
      filters: this.historyFilters,
    });
    if (renderKey === this.historyRenderKey) return;
    const history = required<HTMLOListElement>(this.root, "#event-history");
    const nearBottom =
      history.scrollHeight - history.scrollTop - history.clientHeight < 28;
    history.replaceChildren();
    const filtered = snapshot.auditHistory.filter((event) => {
      if (
        this.historyFilters.round !== "all" &&
        event.round !== Number(this.historyFilters.round)
      ) {
        return false;
      }
      if (
        this.historyFilters.chicken !== "all" &&
        !eventChickenIds(event).includes(this.historyFilters.chicken)
      ) {
        return false;
      }
      const pair = eventPair(event);
      if (
        this.historyFilters.pair !== "all" &&
        (!pair || canonicalPairValue(pair) !== this.historyFilters.pair)
      ) {
        return false;
      }
      if (
        this.historyFilters.context !== "all" &&
        eventContext(event) !== this.historyFilters.context
      ) {
        return false;
      }
      return (
        this.historyFilters.kind === "all" ||
        eventKind(event) === this.historyFilters.kind
      );
    });
    for (const event of filtered) {
      const item = document.createElement("li");
      item.id = `audit-event-${event.eventId}`;
      item.dataset.eventId = String(event.eventId);
      item.textContent = historyLine(event);
      if (event.type === "INTERACTION_RESOLVED")
        item.dataset.context = event.context;
      history.append(item);
    }
    this.historyRenderKey = renderKey;
    required<HTMLElement>(this.root, "#history-filter-result").textContent =
      `${filtered.length} of ${snapshot.auditHistory.length} events match the current filters.`;
    if (nearBottom) history.scrollTop = history.scrollHeight;
  }

  private renderRelationshipHeatmap(checkpoint: FixtureCheckpoint): void {
    if (this.heatmapCheckpointId === checkpoint.checkpointId) return;
    this.heatmapCheckpointId = checkpoint.checkpointId;
    const grid = required<HTMLElement>(this.root, "#checkpoint-heatmap");
    grid.replaceChildren();
    const corner = document.createElement("span");
    corner.className = "heatmap-label";
    corner.textContent = "Δ";
    grid.append(corner);
    for (let qubit = 0; qubit < 6; qubit += 1) {
      const label = document.createElement("span");
      label.className = "heatmap-label";
      label.textContent = `q${qubit}`;
      grid.append(label);
    }
    const parent = checkpoint.parentId
      ? this.requireCheckpoint(checkpoint.parentId)
      : null;
    let strongest = {
      value: 0,
      edge: "root",
      context: "X" as "X" | "Y" | "Z",
    };
    const values = new Map<
      string,
      { value: number; context: "X" | "Y" | "Z" }
    >();
    for (let left = 0; left < 6; left += 1) {
      for (let right = left + 1; right < 6; right += 1) {
        const key = `${left}-${right}`;
        const current = checkpoint.pairs[key];
        const previous = parent?.pairs[key];
        let best = { value: 0, context: "X" as "X" | "Y" | "Z" };
        if (current && previous) {
          for (const context of ["X", "Y", "Z"] as const) {
            const before = previous.distributions[context];
            const after = current.distributions[context];
            const value =
              0.5 *
              (["pp", "pm", "mp", "mm"] as const).reduce(
                (sum, outcome) =>
                  sum + Math.abs(after[outcome] - before[outcome]),
                0,
              );
            if (value > best.value) best = { value, context };
          }
        }
        values.set(key, best);
        if (best.value > strongest.value) {
          strongest = { value: best.value, edge: key, context: best.context };
        }
      }
    }
    for (let row = 0; row < 6; row += 1) {
      const label = document.createElement("span");
      label.className = "heatmap-label";
      label.textContent = `q${row}`;
      grid.append(label);
      for (let column = 0; column < 6; column += 1) {
        const cell = document.createElement("span");
        if (row === column) {
          cell.className = "heatmap-cell is-diagonal";
          cell.textContent = "·";
        } else {
          const key = `${Math.min(row, column)}-${Math.max(row, column)}`;
          const change = values.get(key) ?? { value: 0, context: "X" as const };
          cell.className = "heatmap-cell";
          cell.style.setProperty(
            "--change",
            String(Math.min(1, change.value * 4)),
          );
          cell.dataset.context = change.context;
          cell.title = `${key} · ${change.context} · total variation ${change.value.toFixed(4)}`;
          cell.textContent = change.value > 0 ? change.value.toFixed(2) : "0";
          if (key === strongest.edge) cell.classList.add("is-strongest");
        }
        grid.append(cell);
      }
    }
    required<HTMLElement>(this.root, "#heatmap-legend").textContent = parent
      ? `Parent ${parent.checkpointId} → ${checkpoint.checkpointId}. Strongest pair change ${strongest.edge} in ${strongest.context} (TV ${strongest.value.toFixed(4)}). Topology remains K6; the operation changed the circuit and this matrix reports differences in stored pair distributions.`
      : "Root checkpoint: no parent distribution exists. The matrix begins changing only after a spotlight branch selects a precomputed child.";
  }

  private renderPairComparison(): void {
    const output = required<HTMLElement>(this.root, "#pair-comparison");
    const event = this.currentResolverEvent();
    if (!event) {
      output.innerHTML = "<p>No resolver event is available yet.</p>";
      return;
    }
    if (
      !this.pairComparison ||
      this.pairComparison.sourceEventId !== event.eventId
    ) {
      output.innerHTML = `<p>Event #${event.eventId} is ready. Compare the same recorded draw against the stored joint distribution and its independent product control.</p>`;
      return;
    }
    const comparison = this.pairComparison;
    const outcomeLabel = (outcome: keyof typeof OUTCOME_LABELS) =>
      OUTCOME_LABELS[outcome];
    output.innerHTML = `
      <div class="comparison-summary">
        <strong>${chickenName(comparison.orderedPair[0])} / ${chickenName(comparison.orderedPair[1])} · ${comparison.context} · event #${comparison.sourceEventId}</strong>
        <span>Same draw ${comparison.draw.toFixed(8)}</span>
      </div>
      <div class="comparison-grid">
        <article><span>Stored joint distribution</span><strong>${formatProbabilityVector(comparison.storedVector)}</strong><small>covariance ${comparison.storedCovariance.toFixed(6)}</small><p>${outcomeLabel(comparison.storedOutcome)} → ${comparison.storedActions.a} / ${comparison.storedActions.b}</p></article>
        <article><span>Product of marginals</span><strong>${formatProbabilityVector(comparison.controlVector)}</strong><small>covariance ${comparison.controlCovariance.toFixed(6)}</small><p>${outcomeLabel(comparison.controlOutcome)} → ${comparison.controlActions.a} / ${comparison.controlActions.b}</p></article>
      </div>
      <p class="comparison-marginals">A+ ${(comparison.marginals.aPlus * 100).toFixed(2)}% in both · B+ ${(comparison.marginals.bPlus * 100).toFixed(2)}% in both. The control changes no individual + rate.</p>
      <p class="comparison-verdict">${comparison.outcomeChanged ? "The same draw crosses a different cumulative boundary, so this counterfactual event produces different joint actions." : "The same draw produces the same joint actions in this event, despite the covariance difference."} This is a diagnostic, not evidence of quantum advantage.</p>`;
  }

  private showCode(key: "sampling" | "meaning"): void {
    const source = EXECUTION_SOURCES[key];
    required<HTMLElement>(this.root, "#code-title").textContent =
      `${source.functionName}()`;
    required<HTMLElement>(this.root, "#code-module").textContent =
      `${source.modulePath} · imported with Vite ?raw at build time`;
    required<HTMLElement>(this.root, "#execution-code").textContent =
      source.source;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-code]",
    )) {
      button.setAttribute("aria-pressed", String(button.dataset.code === key));
    }
  }

  private renderStartGate(snapshot: MatchSnapshot): void {
    if (snapshot.tick > 0) this.started = true;
    required<HTMLElement>(this.root, "#start-gate").hidden = this.started;
  }

  private openLab(): void {
    const lab = required<HTMLDetailsElement>(this.root, "#lab-panel");
    lab.open = true;
    lab.scrollIntoView({ behavior: "smooth", block: "start" });
    lab.querySelector<HTMLElement>("summary")?.focus();
  }

  private exportAudit(snapshot: MatchSnapshot): void {
    const payload = {
      schemaVersion: "quantum-royale-audit-v1",
      fixtureBankId: this.bank.fixtureBankId,
      acquisitionSource: this.bank.acquisitionSource,
      resolverMode: snapshot.resolverMode,
      seed: snapshot.seed,
      branchPath: snapshot.branchHistory.map((entry) => ({
        afterRound: entry.afterRound,
        parentCheckpointId: entry.parentCheckpointId,
        childCheckpointId: entry.childCheckpointId,
        branchLabel: entry.branchLabel,
        sourceInteractionEventId: entry.sourceInteractionEventId,
      })),
      events: snapshot.auditHistory,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `quantum-royale-seed-${snapshot.seed}-audit.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private requireCheckpoint(checkpointId: string): FixtureCheckpoint {
    const checkpoint = this.bank.checkpoints[checkpointId];
    if (!checkpoint)
      throw new Error(`Missing committed checkpoint ${checkpointId}.`);
    return checkpoint;
  }

  private runControlAction(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private setStatus(message: string): void {
    const status = required<HTMLElement>(this.root, "#control-status");
    status.textContent = message;
    status.classList.remove("is-error");
  }
}
