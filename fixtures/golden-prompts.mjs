const topics = [
  "Docker containers",
  "OAuth scopes",
  "Postgres indexes",
  "React hydration",
  "browser extensions",
  "rate limits",
  "unit testing",
  "error budgets",
  "API pagination",
  "CSS grid",
  "web accessibility",
  "local-first apps",
  "token budgets",
  "prompt caching",
  "release notes",
  "feature flags",
  "extension options",
  "privacy policies",
  "offline sync",
  "observability"
];

const artifacts = [
  "`exactCall()`",
  "`calculateTotal(items)`",
  "https://api.example.com/v1/orders",
  "/project/reports/final-report.json",
  "\"Prism V1\"",
  "2026-05-20",
  "exactCall();",
  "'preserve this phrase'"
];

export const goldenPrompts = [
  ...topics.map((topic) => ({
    id: `clear-${slug(topic)}`,
    prompt: `Explain ${topic} to a beginner.`,
    mode: "balanced",
    maxTokenGrowth: 7,
    minValuePerTokenDelta: -0.08
  })),
  ...topics.map((topic) => ({
    id: `messy-${slug(topic)}`,
    prompt: `hey can you please explain ${topic} like I am new to programming and keep it not too long`,
    mode: "balanced",
    mustRemove: ["hey", "can you please", "not too long"],
    minValuePerTokenDelta: 0
  })),
  ...topics.map((topic, index) => ({
    id: `constraint-${slug(topic)}`,
    prompt: `Please make a plan for ${topic}. Do not use external APIs. Return risks and next steps.`,
    mode: index % 2 ? "concise" : "balanced",
    mustContain: ["Do not use external APIs"],
    minValuePerTokenDelta: -0.01
  })),
  ...artifacts.flatMap((artifact, index) => ([
    {
      id: `artifact-inline-${index}`,
      prompt: `hey please improve this but preserve ${artifact} exactly and return a checklist`,
      mode: "balanced",
      artifacts: [artifact],
      mustRemove: ["hey", "please"],
      minValuePerTokenDelta: -0.02
    },
    {
      id: `artifact-context-${index}`,
      prompt: [
        "For context, this is part of Prism.",
        `Keep ${artifact} unchanged.`,
        "Write a concise implementation note."
      ].join("\n"),
      mode: "balanced",
      artifacts: [artifact],
      maxTokenGrowth: 16,
      minValuePerTokenDelta: -0.03
    }
  ])),
  {
    id: "fenced-code-preservation",
    prompt: [
      "basically make this faster but keep the code exact",
      "```js",
      "const price = calculateTotal(items);",
      "console.log(price);",
      "```",
      "return a checklist"
    ].join("\n"),
    artifacts: ["```js\nconst price = calculateTotal(items);\nconsole.log(price);\n```"],
    mustRemove: ["basically"],
    minValuePerTokenDelta: -0.03
  },
  {
    id: "json-preservation",
    prompt: [
      "please summarize this config and do not alter the JSON",
      "{",
      "  \"model\": \"gpt-5.2\",",
      "  \"temperature\": 0.2",
      "}",
      "return bullets"
    ].join("\n"),
    artifacts: ["{\n  \"model\": \"gpt-5.2\",\n  \"temperature\": 0.2\n}"],
    minValuePerTokenDelta: -0.03
  },
  {
    id: "ambiguous-but-preserve-intent",
    prompt: "I want this better. The issue is the UI feels too loud. Make it subtle and preserve native controls.",
    mustContain: ["subtle", "preserve native controls"],
    minValuePerTokenDelta: -0.03
  },
  {
    id: "already-structured",
    prompt: "Task: Review the migration\nMust: do not drop data\nOutput: concise risk list",
    maxTokenGrowth: 0,
    mustContain: ["do not drop data"],
    minValuePerTokenDelta: -0.03
  }
];

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
