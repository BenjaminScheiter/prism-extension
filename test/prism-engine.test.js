import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrismEngine } from "../src/core/prism-engine.js";

test("adds default output guidance to already clear tiny prompts", () => {
  const engine = createPrismEngine();
  const original = "Explain Docker containers to a beginner.";

  const result = engine.prism(original, { mode: "balanced" });

  assert.equal(result.output, "Explain Docker containers to a beginner\nOutput: direct, concise, complete");
  assert.equal(result.strategy, "plain");
  assert.equal(result.decision, "minimal");
});

test("uses the smallest useful rewrite for normal messy prompts", () => {
  const engine = createPrismEngine();
  const original = "hey can you please explain docker containers like I am new to programming";

  const result = engine.prism(original, { mode: "balanced" });

  assert.equal(result.output, "Explain docker containers for a beginner\nOutput: direct, concise, complete");
  assert.doesNotMatch(result.output, /^Goal:/m);
  assert.doesNotMatch(result.output, /^Context:/m);
  assert.doesNotMatch(result.output, /^Task:/m);
  assert.doesNotMatch(result.output, /^Constraints:/m);
  assert.doesNotMatch(result.output, /^Quality bar:/m);
  assert.ok(result.metrics.after.waste.count < result.metrics.before.waste.count);
});

test("does not add labels when politeness removal leaves a clear short request", () => {
  const engine = createPrismEngine();
  const original = "I was wondering if maybe you could just summarize the meeting notes in 5 bullets";

  const result = engine.prism(original, { mode: "balanced" });

  assert.equal(result.output, "Summarize the meeting notes in 5 bullets\nOutput: 5 bullets");
  assert.equal(result.strategy, "plain");
  assert.ok(result.metrics.after.tokens <= result.metrics.before.tokens);
});

test("rewrites simple factual questions as compact questions with output guidance, not templates", () => {
  const engine = createPrismEngine();
  const original = "Please tell me how many earthquakes there are yearly";

  const result = engine.prism(original, { mode: "balanced" });

  assert.equal(result.output, "How many earthquakes occur each year\nOutput: direct, concise, complete");
  assert.equal(result.strategy, "plain");
  assert.doesNotMatch(result.output, /^Task:/m);
  assert.equal((result.output.match(/^Output:/gm) || []).length, 1);
});

test("collapses repeated factual prompts instead of preserving multiplied lines", () => {
  const engine = createPrismEngine();
  const original = Array.from({ length: 8 }, () => "Please tell me how many earthquakes there are yearly").join("\n");

  const result = engine.prism(original, { mode: "balanced" });

  assert.equal(result.output, "How many earthquakes occur each year\nOutput: direct, concise, complete");
  assert.equal((result.output.match(/earthquakes/gi) || []).length, 1);
  assert.equal((result.output.match(/^Output:/gm) || []).length, 1);
  assert.ok(result.metrics.after.tokens < result.metrics.before.tokens);
});

test("does not duplicate output guidance on already optimized single-line prompts", () => {
  const engine = createPrismEngine();
  const original = "How many earthquakes occur each year Output: direct, concise, complete";

  const result = engine.prism(original, { mode: "balanced" });

  assert.equal(result.output, original);
  assert.equal((result.output.match(/\bOutput:/g) || []).length, 1);
});

test("can disable default output guidance", () => {
  const engine = createPrismEngine();
  const original = "Explain Docker containers to a beginner.";

  const result = engine.prism(original, { mode: "balanced", defaultOutputGuidance: false });

  assert.equal(result.output, "Explain Docker containers to a beginner");
});

test("can customize default output guidance", () => {
  const engine = createPrismEngine();
  const original = "Please tell me how many earthquakes there are yearly";

  const result = engine.prism(original, { mode: "balanced", outputGuidanceText: "brief but actionable" });

  assert.equal(result.output, "How many earthquakes occur each year\nOutput: brief but actionable");
});

test("does not turn soft brevity preferences into must constraints", () => {
  const engine = createPrismEngine();
  const original = "Maybe just compare Stripe Checkout and PaymentIntents for a marketplace app, keep it short";

  const result = engine.prism(original, { mode: "balanced" });

  assert.doesNotMatch(result.output, /^Must:/m);
  assert.match(result.output, /Compare Stripe Checkout and PaymentIntents/i);
  assert.doesNotMatch(result.output, /maybe|just|keep it short/i);
  assert.doesNotMatch(result.output, /,,/);
});

test("adds a compact must line only when constraints or artifacts need protection", () => {
  const engine = createPrismEngine();
  const original = "please make this function faster but do not change `calculateTotal(items)`";

  const result = engine.prism(original, { mode: "balanced" });

  assert.match(result.output, /^Task:/);
  assert.match(result.output, /^Must: /m);
  assert.match(result.output, /`calculateTotal\(items\)`/);
  assert.match(result.output, /\nOutput: direct, concise, complete$/);
  assert.doesNotMatch(result.output, /^Context:/m);
  assert.doesNotMatch(result.output, /^Quality bar:/m);
});

test("compresses repeated messy prompts instead of expanding them", () => {
  const engine = createPrismEngine();
  const paragraph = [
    "hey so basically I need a launch plan for Prism.",
    "Keep privacy local and do not use external APIs.",
    "Return MVP scope, launch sequence, risks, and what not to build.",
    "Keep privacy local and do not use external APIs.",
    "Return MVP scope, launch sequence, risks, and what not to build."
  ].join("\n");

  const result = engine.prism(paragraph, { mode: "balanced" });

  assert.ok(result.metrics.after.tokens < result.metrics.before.tokens, `${result.metrics.before.tokens} -> ${result.metrics.after.tokens}\n${result.output}`);
  assert.match(result.output, /^Task:/);
  assert.match(result.output, /^Must: /m);
  assert.doesNotMatch(result.output, /^Quality bar:/m);
});

test("extracts task, constraints, and output from one-line multi-sentence prompts", () => {
  const engine = createPrismEngine();
  const original = "Write a SQL migration. Use Postgres 15. Do not drop existing data. Return only SQL.";

  const result = engine.prism(original, { mode: "balanced" });

  assert.match(result.output, /^Task: Write a SQL migration/m);
  assert.match(result.output, /^Must: .*Use Postgres 15.*Do not drop existing data/m);
  assert.match(result.output, /^Output: only SQL/m);
  assert.doesNotMatch(result.output, /^Quality bar:/m);
});

test("selects the real request instead of background context", () => {
  const engine = createPrismEngine();
  const original = [
    "I am building Prism, a local Chrome extension that rewrites prompts before they are sent.",
    "The goal is value per token, not pretty prompts.",
    "The current version uses the same fixed template every time and users hate it because short prompts become longer.",
    "I want a better method that changes by prompt.",
    "Please analyze the best strategy, explain the logic, and return implementation priorities."
  ].join("\n");

  const result = engine.prism(original, { mode: "balanced" });

  assert.match(result.output, /^Task: Analyze the best strategy, explain the logic, and return implementation priorities/m);
  assert.match(result.output, /^Context: .*fixed template.*better method/m);
  assert.doesNotMatch(result.output, /^Task: I am building Prism/m);
  assert.ok(result.metrics.after.tokens < result.metrics.before.tokens);
});

test("strips request lead-ins after ranking the real task", () => {
  const engine = createPrismEngine();
  const original = [
    "For context, this is for Prism.",
    "The current problem is prompt rewrites are too long.",
    "What I want you to do now: tighten the rewrite rules and return three implementation steps."
  ].join("\n");

  const result = engine.prism(original, { mode: "balanced" });

  assert.match(result.output, /^Task: Tighten the rewrite rules and return three implementation steps/m);
  assert.doesNotMatch(result.output, /What I want you to do now/i);
  assert.match(result.output, /^Context: .*prompt rewrites are too long/m);
});

test("splits background from a lowercase task after a sentence boundary", () => {
  const engine = createPrismEngine();
  const original = "I am building a Chrome extension. Please debug why Perplexity sends the old prompt and propose a fix.";

  const result = engine.prism(original, { mode: "balanced" });

  assert.match(result.output, /^Task: Debug why Perplexity sends the old prompt and propose a fix/m);
  assert.doesNotMatch(result.output, /^Task: I am building a Chrome extension/m);
});

test("protects exact artifacts while reducing waste", () => {
  const engine = createPrismEngine();
  const original = [
    "hey so basically I was wondering if you could maybe help me please",
    "make this function faster but do not change `calculateTotal(items)`",
    "",
    "```js",
    "const price = calculateTotal(items);",
    "console.log(price);",
    "```",
    "",
    "also here is the endpoint https://api.example.com/v1/orders",
    "and the file /project/reports/final-report.json"
  ].join("\n");

  const result = engine.prism(original, { mode: "balanced" });

  assert.match(result.output, /^Task:/);
  assert.match(result.output, /^Must:/m);
  assert.match(result.output, /^Output:/m);
  assert.match(result.output, /^Artifacts:/m);
  assert.doesNotMatch(result.output, /^Quality bar:/m);
  assert.match(result.output, /`calculateTotal\(items\)`/);
  assert.match(result.output, /```js\nconst price = calculateTotal\(items\);\nconsole\.log\(price\);\n```/);
  assert.match(result.output, /https:\/\/api\.example\.com\/v1\/orders/);
  assert.match(result.output, /\/project\/reports\/final-report\.json/);
  assert.ok(result.metrics.after.waste.count < result.metrics.before.waste.count);
  assert.ok(result.metrics.after.valuePerToken > result.metrics.before.valuePerToken);
  assert.ok(result.metrics.valuePerTokenDelta > 0);
});

test("preserves bare code-like statements as exact artifacts", () => {
  const engine = createPrismEngine();
  const result = engine.prism(
    ["basically make this shorter; keep `exactCall()`", "exactCall();", "return a checklist"].join("\n"),
    { mode: "balanced" }
  );

  assert.match(result.output, /`exactCall\(\)`/);
  assert.match(result.output, /exactCall\(\);/);
  assert.doesNotMatch(result.output, /basically/);
  assert.ok(result.metrics.protectedArtifacts >= 2);
});

test("keeps explicit user intent and exact quoted strings", () => {
  const engine = createPrismEngine();
  const result = engine.prism(
    'Need a launch checklist for "Prism V1" by 2026-05-20. It should be really very concise and not too long.',
    { mode: "concise" }
  );

  assert.match(result.output, /launch checklist/i);
  assert.match(result.output, /"Prism V1"/);
  assert.match(result.output, /2026-05-20/);
  assert.doesNotMatch(result.output, /really very/);
});

test("scores quality per token from requirements, constraints, and artifacts", () => {
  const engine = createPrismEngine();
  const result = engine.analyze(
    "Build a Chrome extension. Keep API keys private. Use manifest v3. Return a zip."
  );

  assert.equal(result.artifacts.count, 0);
  assert.ok(result.intent.score > 0);
  assert.ok(result.constraints.count >= 1);
  assert.ok(result.structure.score > 0);
  assert.ok(result.valuePerToken > 0);
});

test("builds an intent frame and preserves decision criteria", () => {
  const engine = createPrismEngine();
  const result = engine.prism(
    "I need to decide between Supabase and Firebase for a small SaaS. Cost matters, I am solo, I need auth and Postgres-like querying. Return recommendation."
  );

  assert.equal(result.frame.taskType, "decision");
  assert.equal(result.decision, "apply");
  assert.ok(result.confidence >= 0.7);
  assert.match(result.output, /Supabase and Firebase/i);
  assert.match(result.output, /cost matters/i);
  assert.match(result.output, /solo/i);
  assert.match(result.output, /auth/i);
  assert.match(result.output, /Postgres-like querying/i);
  assert.match(result.output, /^Context:/m);
});

test("abstains when a vague prompt would risk changing intent", () => {
  const engine = createPrismEngine();
  const original = "make it better";
  const result = engine.prism(original);

  assert.equal(result.decision, "abstain");
  assert.ok(result.confidence < 0.5);
  assert.deepEqual(result.riskReasons, ["vague task"]);
  assert.equal(result.output, original);
});

test("uses minimal decision for clear short prompts", () => {
  const engine = createPrismEngine();
  const result = engine.prism("Explain Docker containers to a beginner.");

  assert.equal(result.decision, "minimal");
  assert.equal(result.frame.taskType, "explanation");
  assert.equal(result.strategy, "plain");
  assert.equal(result.output, "Explain Docker containers to a beginner\nOutput: direct, concise, complete");
});

test("keeps exact artifacts in the frame and gated rewrite", () => {
  const engine = createPrismEngine();
  const result = engine.prism("please fix this but keep `calculateTotal(items)` exact");

  assert.equal(result.frame.artifacts.length, 1);
  assert.equal(result.decision, "apply");
  assert.match(result.output, /`calculateTotal\(items\)`/);
  assert.ok(result.confidence >= 0.65);
});
