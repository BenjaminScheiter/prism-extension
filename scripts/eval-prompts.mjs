#!/usr/bin/env node
import { createPrismEngine } from "../src/core/prism-engine.js";
import { goldenPrompts } from "../fixtures/golden-prompts.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const engine = createPrismEngine();
const results = goldenPrompts.map(runCase);
const failures = results.filter((result) => !result.ok);
const summary = {
  total: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  artifactPreservation: artifactPreservationRate(results),
  averageTokenDelta: round(average(results.map((result) => result.tokenDelta))),
  averageValuePerTokenDelta: round(average(results.map((result) => result.valuePerTokenDelta))),
  failures,
};

if (asJson) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  console.log(`Prism eval: ${summary.passed}/${summary.total} passed`);
  console.log(`artifact_preservation: ${summary.artifactPreservation}`);
  console.log(`average_token_delta: ${summary.averageTokenDelta}`);
  console.log(`average_value_per_token_delta: ${summary.averageValuePerTokenDelta}`);
  for (const failure of failures.slice(0, 8)) {
    console.log(`FAIL ${failure.id}: ${failure.errors.join("; ")}`);
  }
}

if (failures.length) process.exit(1);

function runCase(testCase) {
  const result = engine.prism(testCase.prompt, { mode: testCase.mode || "balanced" });
  const errors = [];
  const output = result.output;
  const lowerOutput = output.toLowerCase();

  for (const artifact of testCase.artifacts || []) {
    if (!output.includes(artifact)) errors.push(`missing artifact ${JSON.stringify(artifact)}`);
  }

  for (const text of testCase.mustContain || []) {
    if (!lowerOutput.includes(String(text).toLowerCase())) errors.push(`missing required text ${JSON.stringify(text)}`);
  }

  for (const text of testCase.mustRemove || []) {
    if (lowerOutput.includes(String(text).toLowerCase())) errors.push(`waste text remains ${JSON.stringify(text)}`);
  }

  const tokenDelta = result.metrics.after.tokens - result.metrics.before.tokens;
  if (Number.isFinite(testCase.maxTokenGrowth) && tokenDelta > testCase.maxTokenGrowth) {
    errors.push(`token growth ${tokenDelta} > ${testCase.maxTokenGrowth}`);
  }

  const valuePerTokenDelta = result.metrics.after.valuePerToken - result.metrics.before.valuePerToken;
  if (Number.isFinite(testCase.minValuePerTokenDelta) && valuePerTokenDelta < testCase.minValuePerTokenDelta) {
    errors.push(`value/token delta ${round(valuePerTokenDelta)} < ${testCase.minValuePerTokenDelta}`);
  }

  return {
    id: testCase.id,
    ok: errors.length === 0,
    errors,
    strategy: result.strategy,
    tokenDelta,
    valuePerTokenDelta: round(valuePerTokenDelta),
    beforeTokens: result.metrics.before.tokens,
    afterTokens: result.metrics.after.tokens,
    artifactCount: (testCase.artifacts || []).length,
    preservedArtifacts: (testCase.artifacts || []).filter((artifact) => output.includes(artifact)).length,
    output
  };
}

function artifactPreservationRate(results) {
  const artifactCases = results.filter((result) => result.artifactCount > 0);
  const total = artifactCases.reduce((sum, result) => sum + result.artifactCount, 0);
  if (!total) return 1;
  return round(artifactCases.reduce((sum, result) => sum + result.preservedArtifacts, 0) / total);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
