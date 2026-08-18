import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const SCREENSHOT_DIR = resolve("qa/screenshots");
const ENTRY_PATH = process.env.QUANTUM_ROYALE_E2E_BASE_PATH ?? "/";
mkdirSync(SCREENSHOT_DIR, { recursive: true });

function screenshotPath(name: string): string {
  return resolve(SCREENSHOT_DIR, name);
}

function installFailureCollection(page: Page): {
  errors: string[];
  requests: string[];
} {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("requestfailed", (request) =>
    errors.push(
      `request: ${request.url()} · ${request.failure()?.errorText ?? "failed"}`,
    ),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(`response: ${response.status()} ${response.url()}`);
  });
  page.on("request", (request) => requests.push(request.url()));
  return { errors, requests };
}

async function waitForTestApi(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__QUANTUM_ROYALE_TEST__)))
    .toBe(true);
  await expect(page.locator("#game-canvas canvas")).toBeVisible();
}

async function startAndFreeze(page: Page): Promise<void> {
  await page.locator("#start-match").click();
  await expect(page.locator("#start-gate")).toBeHidden();
  await expect(page.locator('[data-speed="1"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#pause-match").click();
  await expect(page.locator("#pause-match")).toHaveText("Resume");
}

async function advanceUntilContext(
  page: Page,
  context: "X" | "Y" | "Z",
  maximumTicks: number,
): Promise<void> {
  const found = await page.evaluate(
    ({ wantedContext, maximum }) => {
      const api = window.__QUANTUM_ROYALE_TEST__;
      if (!api) throw new Error("Test API unavailable.");
      for (let count = 0; count < maximum; count += 1) {
        const snapshot = api.advanceTicks(1);
        const event = snapshot.latestInteraction;
        if (event?.context === wantedContext && event.tick === snapshot.tick)
          return true;
        if (snapshot.phase !== "round") return false;
      }
      return false;
    },
    { wantedContext: context, maximum: maximumTicks },
  );
  expect(found).toBe(true);
}

async function advanceToPhase(
  page: Page,
  phase: "intermission" | "finished",
): Promise<void> {
  await page.evaluate((wantedPhase) => {
    const api = window.__QUANTUM_ROYALE_TEST__;
    if (!api) throw new Error("Test API unavailable.");
    for (let count = 0; count < 4_000; count += 1) {
      const snapshot = api.getSnapshot();
      if (snapshot.phase === wantedPhase) return;
      if (snapshot.phase !== "round")
        throw new Error(`Stopped at ${snapshot.phase} before ${wantedPhase}.`);
      api.advanceTicks(1);
    }
    throw new Error(`Did not reach ${wantedPhase}.`);
  }, phase);
  await expect
    .poll(() =>
      page.evaluate(() => window.__QUANTUM_ROYALE_TEST__?.getSnapshot().phase),
    )
    .toBe(phase);
}

async function placeTicketAndContinue(
  page: Page,
  chickenId: string,
  stake: number,
): Promise<void> {
  await page.locator(`[data-bet-chicken="${chickenId}"]`).click();
  await page.locator(`[data-bet-stake="${stake}"]`).click();
  await page.locator("#place-bet").click();
  await expect(page.locator("#bet-decision")).toContainText("Locked:");
  await page.locator("#continue-match").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__QUANTUM_ROYALE_TEST__?.getSnapshot().phase),
    )
    .toBe("round");
}

test("@desktop public journey preserves one game-first causal chain", async ({
  page,
}) => {
  const observed = installFailureCollection(page);
  await page.goto(`${ENTRY_PATH}?test=1`, { waitUntil: "networkidle" });
  await waitForTestApi(page);

  await expect(
    page.getByRole("heading", { name: "Quantum Royale V2.4" }),
  ).toBeVisible();
  await expect(page.locator("#start-gate")).toBeVisible();
  const initial = await page.evaluate(() =>
    window.__QUANTUM_ROYALE_TEST__?.getSnapshot(),
  );
  expect(initial?.tick).toBe(0);
  expect(initial?.paused).toBe(true);
  expect(initial?.speed).toBe(1);
  await expect(page.locator("#pause-match")).toBeDisabled();
  await expect(page.locator(".leader-card")).toHaveCount(6);
  await expect(page.locator(".leader-health-track")).toHaveCount(6);
  await expect(page.locator(".leader-score").first()).toHaveText("0");

  await page.locator("#start-open-lab").click();
  await expect(page.locator("#lab-panel")).toHaveAttribute("open", "");
  const labTitles = await page
    .locator(".lab-group > .lab-group-heading h2")
    .allTextContents();
  expect(labTitles).toEqual([
    "From circuit to consequence",
    "K6 relation field and branch tree",
    "What was computed—and what is not claimed",
    "Reconstruct or challenge the run",
  ]);
  await expect(page.locator("#role-history-grid")).toHaveCount(0);
  await expect(page.locator("#ticket-ledger")).toHaveCount(0);
  await expect(page.locator("#run-diagnostic")).toHaveCount(0);
  await expect(page.locator(".live-resolver")).toHaveCount(1);
  await expect(page.locator(".offline-boundary")).toContainText(
    "no QPU, Aer simulator, Python process, provider, or Moth API",
  );
  await expect(page.locator("#branch-rule")).toHaveText(
    "++ / -- → MATCHED_ACTION; +- / -+ → SPLIT_ACTION",
  );

  await startAndFreeze(page);
  await expect(page.locator("#sound-audit")).not.toContainText("LOCKED");
  const openingDeskLine = await page.locator("#desk-line").textContent();
  await page.locator('[data-track-chicken="buttercup-blitz"]').click();
  await expect(
    page.locator('[data-track-chicken="buttercup-blitz"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#presenter-caption")).toContainText(/Buttercup/i);
  await expect(page.locator("#desk-line")).toHaveText(openingDeskLine ?? "");
  await expect(page.locator(".relation-legend")).toContainText(
    "BLUE · OBSERVED",
  );
  await expect(page.locator(".relation-legend")).toContainText(
    "GREY · OTHER ACTIVE",
  );

  await advanceUntilContext(page, "X", 650);
  const resolver = await page.evaluate(() => {
    const snapshot = window.__QUANTUM_ROYALE_TEST__?.getSnapshot();
    const event = snapshot?.latestInteraction;
    return event
      ? {
          eventId: event.eventId,
          draw: event.prngDraw,
          outcome: event.jointOutcome,
        }
      : null;
  });
  await expect(page.locator("#trace-event-id")).toHaveText(
    `EVENT #${resolver?.eventId}`,
  );
  await expect(page.locator("#trace-draw")).toHaveText(
    resolver?.draw.toFixed(8) ?? "",
  );
  await expect(
    page.locator(`[data-probability="${resolver?.outcome}"]`),
  ).toHaveClass(/is-selected/);
  await expect(page.locator("#trace-reason")).toHaveText("combat proximity");
  await expect(page.locator("#compare-current-event")).toBeEnabled();
  await page.locator("#compare-current-event").click();
  await expect(page.locator("#pair-comparison")).toContainText("Same draw");
  await expect(page.locator("#pair-comparison")).toContainText(
    "The control changes no individual + rate",
  );
  await expect(page.locator("#pair-comparison")).toContainText(
    "not evidence of quantum advantage",
  );
  await page.screenshot({
    path: screenshotPath("01-v24-live-resolver.png"),
    fullPage: false,
  });

  await advanceToPhase(page, "intermission");
  await expect(page.locator("#intermission-title")).toContainText(
    "checkpoint committed",
  );
  await expect(page.locator(".checkpoint-chain")).toContainText("RESOLVER #");
  await expect(page.locator(".checkpoint-chain")).toContainText("OUTCOME");
  await expect(page.locator(".checkpoint-chain")).toContainText("ACTION");
  await expect(page.locator(".offline-note")).toContainText(
    "computed offline before play",
  );
  await expect(page.locator("#checkpoint-heatmap > *")).toHaveCount(49);
  const intermissionGeometry = await page.evaluate(() => {
    const form = document.querySelector<HTMLElement>("#bet-form");
    return {
      bottom: form?.getBoundingClientRect().bottom ?? Infinity,
      viewport: window.innerHeight,
    };
  });
  expect(intermissionGeometry.bottom).toBeLessThanOrEqual(
    intermissionGeometry.viewport + 1,
  );
  await page.screenshot({
    path: screenshotPath("02-v24-checkpoint-betting.png"),
    fullPage: false,
  });

  await placeTicketAndContinue(page, "velvet-talon", 10);
  await advanceToPhase(page, "intermission");
  await placeTicketAndContinue(page, "cornfield-comet", 10);
  await advanceToPhase(page, "intermission");
  await page.locator("#skip-bet").click();
  await page.locator("#continue-match").click();
  await advanceToPhase(page, "finished");

  await expect(page.locator("#result-card")).toBeVisible();
  await expect(page.locator("#result-title")).toContainText("wins");
  await expect(page.locator("#result-ranking")).toContainText("KO");
  await expect(page.locator("#result-decision")).toContainText("Winner rule:");
  await expect(page.locator("#result-pair")).toContainText("relation history");
  await expect(page.locator("#result-payout")).toContainText("points");
  await expect(page.locator("#interview-progress")).toHaveText(
    "Interview 1 / 6",
  );
  const names = new Set<string>();
  for (let index = 0; index < 6; index += 1) {
    names.add((await page.locator("#interview-name").textContent()) ?? "");
    await expect(page.locator("#interview-trace")).toContainText(
      "damage dealt",
    );
    if (index < 5) await page.locator("#next-interview").click();
  }
  expect(names.size).toBe(6);
  await page.locator("#skip-interviews").click();
  await expect(page.locator("#interview-name")).toHaveText(
    "Interviews collapsed",
  );
  await page.locator("#skip-interviews").click();
  await expect(page.locator("#interview-progress")).toHaveText(
    "Interview 6 / 6",
  );

  await page.locator("#restart-result").click();
  await expect(page.locator("#start-gate")).toBeVisible();
  const restarted = await page.evaluate(() =>
    window.__QUANTUM_ROYALE_TEST__?.getSnapshot(),
  );
  expect(restarted?.tick).toBe(0);
  expect(restarted?.paused).toBe(true);
  expect(restarted?.auditHistory.map((event) => event.type)).toEqual([
    "MATCH_STARTED",
    "ROUND_STARTED",
  ]);
  expect(observed.errors).toEqual([]);
  const pageOrigin = new URL(page.url()).origin;
  expect(
    observed.requests.every((url) => new URL(url).origin === pageOrigin),
  ).toBe(true);
});

test("@desktop seed 5 keeps roles final and exports the complete audit", async ({
  page,
}) => {
  const observed = installFailureCollection(page);
  await page.goto(`${ENTRY_PATH}?test=1&seed=5`, { waitUntil: "networkidle" });
  await waitForTestApi(page);
  await startAndFreeze(page);
  for (let round = 1; round <= 3; round += 1) {
    await advanceToPhase(page, "intermission");
    const snapshot = await page.evaluate(() =>
      window.__QUANTUM_ROYALE_TEST__?.getSnapshot(),
    );
    expect(snapshot?.roleStates["scarlet-bantam"].history).toHaveLength(0);
    await page.locator("#skip-bet").click();
    await page.locator("#continue-match").click();
  }
  await advanceToPhase(page, "finished");
  const finished = await page.evaluate(() =>
    window.__QUANTUM_ROYALE_TEST__?.getSnapshot(),
  );
  expect(finished?.roleStates["scarlet-bantam"].history).toHaveLength(1);
  await expect(page.locator("#interview-identity")).toContainText(
    "FINAL READ:",
  );

  await page.locator("#lab-panel > summary").click();
  await page.locator("#history-details > summary").click();
  await expect(page.locator("#event-history li")).not.toHaveCount(0);
  await page.locator("#history-context").selectOption("X");
  await expect(page.locator("#history-filter-result")).toContainText("match");
  const download = page.waitForEvent("download");
  await page.locator("#export-audit").click();
  const audit = await download;
  expect(audit.suggestedFilename()).toBe("quantum-royale-seed-5-audit.json");
  expect(observed.errors).toEqual([]);
});

test("@narrow scoreboard remains a 2 by 3 grid without horizontal overflow", async ({
  page,
}) => {
  const observed = installFailureCollection(page);
  await page.goto(`${ENTRY_PATH}?test=1&seed=5`, { waitUntil: "networkidle" });
  await waitForTestApi(page);
  const dimensions = await page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>(".leader-card")];
    const lefts = new Set(
      cards.map((card) => Math.round(card.getBoundingClientRect().left)),
    );
    const tops = new Set(
      cards.map((card) => Math.round(card.getBoundingClientRect().top)),
    );
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      columns: lefts.size,
      rows: tops.size,
    };
  });
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
  expect(dimensions.columns).toBe(2);
  expect(dimensions.rows).toBe(3);
  await startAndFreeze(page);
  await advanceToPhase(page, "intermission");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: screenshotPath("03-v24-narrow-intermission.png"),
    fullPage: true,
  });
  expect(observed.errors).toEqual([]);
});
