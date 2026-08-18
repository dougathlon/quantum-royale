import Phaser from "phaser";

import fixtureBankJson from "../fixtures/quantum-royale-aer-v1.json";
import type { MatchSpeed } from "./config/tuning";
import type { ChickenId } from "./content/chickens";
import { validateFixtureBank } from "./fixtures/validateFixtureBank";
import { QuantumRoyaleScene } from "./game/QuantumRoyaleScene";
import { FIELD_VIEW } from "./presentation/projection";
import { QuantumRoyaleSimulation } from "./simulation/QuantumRoyaleSimulation";
import type { FramePacket } from "./simulation/types";
import "./styles.css";
import { GameUI } from "./ui/GameUI";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Quantum Royale requires #app.");

const bank = validateFixtureBank(fixtureBankJson);
const requestedSeed = Number(
  new URLSearchParams(window.location.search).get("seed") ?? 260817,
);
const matchSeed =
  Number.isSafeInteger(requestedSeed) && requestedSeed > 0
    ? requestedSeed
    : 260817;
const simulation = new QuantumRoyaleSimulation(bank, matchSeed, "quantum", {
  validateFixtures: false,
});
simulation.setPaused(true);
const testControlsEnabled =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_API === "1";
const testMode =
  testControlsEnabled &&
  new URLSearchParams(window.location.search).get("test") === "1";

let scene: QuantumRoyaleScene;
let ui: GameUI;

const deliverExternalPacket = (packet: FramePacket): void => {
  scene.applyFramePacket(packet);
  ui.render(packet);
};

ui = new GameUI(root, simulation, bank, {
  onExternalPacket: deliverExternalPacket,
  onPresentationFocus: (focus, snapshot) =>
    scene.setPresentationFocus(focus, snapshot),
});
scene = new QuantumRoyaleScene(simulation, (packet) => ui.render(packet));

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game-canvas",
  width: FIELD_VIEW.width,
  height: FIELD_VIEW.height,
  backgroundColor: "#09070a",
  scene,
  render: {
    antialias: false,
    pixelArt: true,
    roundPixels: true,
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: FIELD_VIEW.width,
    height: FIELD_VIEW.height,
  },
  banner: false,
});

if (testMode) {
  window.__QUANTUM_ROYALE_TEST__ = {
    getSnapshot: () => simulation.getSnapshot(),
    advanceTicks: (count: number) => {
      const packet = simulation.advanceTicks(count);
      deliverExternalPacket(packet);
      return packet.snapshot;
    },
    setSpeed: (speed: MatchSpeed) => {
      simulation.setSpeed(speed);
      const packet = simulation.updateFrame(0);
      deliverExternalPacket(packet);
      return packet.snapshot;
    },
    placeBet: (chickenId: ChickenId, stake: number) => {
      simulation.placeBet(chickenId, stake);
      const packet = simulation.drainFramePacket();
      deliverExternalPacket(packet);
      return packet.snapshot;
    },
    skipBet: () => {
      simulation.skipBet();
      const packet = simulation.drainFramePacket();
      deliverExternalPacket(packet);
      return packet.snapshot;
    },
    continueMatch: () => {
      simulation.continueFromIntermission();
      const packet = simulation.drainFramePacket();
      deliverExternalPacket(packet);
      return packet.snapshot;
    },
    restart: () => {
      const resetPacket = simulation.restart();
      simulation.setPaused(true);
      const pausedPacket = simulation.drainFramePacket();
      const packet: FramePacket = Object.freeze({
        snapshot: pausedPacket.snapshot,
        events: resetPacket.events,
      });
      deliverExternalPacket(packet);
      return packet.snapshot;
    },
    runProductControlDiagnostic: () => simulation.runProductControlDiagnostic(),
  };
}

window.addEventListener(
  "beforeunload",
  () => {
    game.destroy(true);
  },
  { once: true },
);
