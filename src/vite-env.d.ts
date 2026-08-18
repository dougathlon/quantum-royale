/// <reference types="vite/client" />

declare module "*?raw" {
  const content: string;
  export default content;
}

interface Window {
  __QUANTUM_ROYALE_TEST__?: {
    getSnapshot: () => import("./simulation/types").MatchSnapshot;
    advanceTicks: (count: number) => import("./simulation/types").MatchSnapshot;
    setSpeed: (
      speed: import("./config/tuning").MatchSpeed,
    ) => import("./simulation/types").MatchSnapshot;
    placeBet: (
      chickenId: import("./content/chickens").ChickenId,
      stake: number,
    ) => import("./simulation/types").MatchSnapshot;
    skipBet: () => import("./simulation/types").MatchSnapshot;
    continueMatch: () => import("./simulation/types").MatchSnapshot;
    restart: () => import("./simulation/types").MatchSnapshot;
    runProductControlDiagnostic: () => import("./simulation/types").DiagnosticResult;
  };
}
