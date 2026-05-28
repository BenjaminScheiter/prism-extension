import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrismEngine } from "../src/core/prism-engine.js";
import { goldenPrompts } from "../fixtures/golden-prompts.mjs";

test("golden prompt corpus preserves artifacts and avoids wasteful expansion", () => {
  const engine = createPrismEngine();
  const failures = [];

  for (const item of goldenPrompts) {
    const result = engine.prism(item.prompt, { mode: item.mode || "balanced" });
    const output = result.output;
    const lower = output.toLowerCase();
    const errors = [];

    for (const artifact of item.artifacts || []) {
      if (!output.includes(artifact)) errors.push(`missing artifact ${JSON.stringify(artifact)}`);
    }
    for (const text of item.mustContain || []) {
      if (!lower.includes(String(text).toLowerCase())) errors.push(`missing ${JSON.stringify(text)}`);
    }
    for (const text of item.mustRemove || []) {
      if (lower.includes(String(text).toLowerCase())) errors.push(`still has ${JSON.stringify(text)}`);
    }

    const tokenDelta = result.metrics.after.tokens - result.metrics.before.tokens;
    if (Number.isFinite(item.maxTokenGrowth) && tokenDelta > item.maxTokenGrowth) {
      errors.push(`token growth ${tokenDelta} > ${item.maxTokenGrowth}`);
    }

    const valueDelta = result.metrics.after.valuePerToken - result.metrics.before.valuePerToken;
    if (Number.isFinite(item.minValuePerTokenDelta) && valueDelta < item.minValuePerTokenDelta) {
      errors.push(`value/token delta ${valueDelta.toFixed(3)} < ${item.minValuePerTokenDelta}`);
    }

    if (errors.length) failures.push(`${item.id}: ${errors.join("; ")}\n${output}`);
  }

  assert.deepEqual(failures, []);
});
