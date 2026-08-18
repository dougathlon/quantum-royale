import resolverSource from "../fixtures/FixtureResolver.ts?raw";
import semanticsSource from "../simulation/resolveJointOutcome.ts?raw";

export interface ExecutionSource {
  modulePath: string;
  functionName: string;
  source: string;
}

function excerpt(
  source: string,
  startMarker: string,
  endMarker?: string,
): string {
  const start = source.indexOf(startMarker);
  if (start < 0)
    throw new Error(`Execution source marker not found: ${startMarker}`);
  const end = endMarker
    ? source.indexOf(endMarker, start + startMarker.length)
    : source.length;
  return source.slice(start, end < 0 ? source.length : end).trim();
}

export const EXECUTION_SOURCES = {
  sampling: {
    modulePath: "src/fixtures/FixtureResolver.ts",
    functionName: "selectOutcome",
    source: excerpt(
      resolverSource,
      "export function selectOutcome",
      "export class FixtureResolver",
    ),
  },
  meaning: {
    modulePath: "src/simulation/resolveJointOutcome.ts",
    functionName: "resolveJointOutcome",
    source: excerpt(semanticsSource, "export function resolveJointOutcome"),
  },
} as const satisfies Record<string, ExecutionSource>;
