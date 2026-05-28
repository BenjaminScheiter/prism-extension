(() => {
const DEFAULT_OPTIONS = {
  mode: "balanced",
  defaultOutputGuidance: true,
  outputGuidanceText: "direct, concise, complete"
};

const WASTE_REPLACEMENTS = [
  [/\bi was wondering if\s+(?:maybe\s+|possibly\s+)?(?:you could|you can|you would)\b/gi, ""],
  [/\bit would be great if\s+(?:you could|you can|you would)\b/gi, ""],
  [/\bwould you mind\b/gi, ""],
  [/\bwhen you get a chance\b/gi, ""],
  [/\bif possible\b/gi, ""],
  [/\blike\s+I\s+am\s+new\s+to\s+programming\b/gi, "for a beginner"],
  [/\blike\s+I\s+am\s+(?:a\s+)?beginner\b/gi, "for a beginner"],
  [/\b(?:and\s+)?keep it (?:not too long|short|brief|concise)\b/gi, ""],
  [/\bno need to be (?:super\s+|too\s+)?(?:detailed|long|verbose)\b/gi, "concise"],
  [/\bnot (?:too\s+)?(?:long|verbose|detailed)\b/gi, "concise"]
];

const WASTE_PATTERNS = [
  /\bhey\b/gi,
  /\bhi there\b/gi,
  /\bso basically\b/gi,
  /\bbasically\b/gi,
  /\bi was wondering if you could\b/gi,
  /\bcould you please\b/gi,
  /\bcan you please\b/gi,
  /\bplease\b/gi,
  /\bmaybe\b/gi,
  /\bpossibly\b/gi,
  /\bkind of\b/gi,
  /\bsort of\b/gi,
  /\ba little bit\b/gi,
  /\breally very\b/gi,
  /\breally\b/gi,
  /\bvery\b/gi,
  /\bsuper\b/gi,
  /\bjust\b/gi,
  /\bI think\b/gi,
  /\bit should be\b/gi,
  /\bnot too long\b/gi,
  /\balso\b/gi,
  /(?<!-)\blike\b(?!-)/gi
];

const CONSTRAINT_HINTS = /\b(do not|don't|must|keep|preserve|without|never|only|avoid|use|ensure|protect|private|exact)\b/i;
const DELIVERABLE_HINTS = /\b(return|give|provide|deliver|write|build|make|create|generate|produce|ship)\b/i;
const TASK_START_WORDS = "analyze|answer|build|calculate|classify|compare|create|debug|design|draft|estimate|explain|extract|find|fix|generate|improve|make|optimize|plan|produce|reduce|refactor|review|rewrite|ship|summarize|tell|test|verify|write";
const TASK_VERBS = new RegExp(`\\b(${TASK_START_WORDS})\\b`, "i");
const TASK_START = new RegExp(`^(${TASK_START_WORDS})\\b`, "i");
const SENTENCE_TASK_BOUNDARY = new RegExp(`(?<=[.!?])\\s+(?=(?:[A-Z0-9"\`']|(?:please\\s+)?(?:${TASK_START_WORDS})\\b))`, "i");

function createPrismEngine(defaultOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...defaultOptions };

  return {
    analyze(text) {
      return analyzePrompt(text, options);
    },
    prism(text, overrideOptions = {}) {
      return prismPrompt(text, { ...options, ...overrideOptions });
    }
  };
}

function prismPrompt(text, options = DEFAULT_OPTIONS) {
  const normalized = normalizeInput(text);
  const before = analyzePrompt(normalized, options);
  const protectedText = protectArtifacts(normalized);
  const cleaned = cleanWaste(protectedText.text);
  const uniqueLines = dedupeLines(cleaned);
  const dedupedPhysicalText = dedupePhysicalLines(cleaned);
  const profile = buildAdaptiveProfile(uniqueLines, protectedText.artifacts, before, options);
  const frame = buildIntentFrame(profile, uniqueLines, protectedText.artifacts, before);
  applyIntentFrameToProfile(profile, frame);
  const chosen = chooseAdaptiveCandidate(
    buildAdaptiveCandidates(profile, dedupedPhysicalText, options),
    before,
    protectedText.artifacts,
    profile
  );
  const gate = evaluateRewriteGate(profile, frame, before, chosen);
  const gatedChoice = applyRewriteGate(gate, chosen, protectedText.text);
  const restoredOutput = restoreArtifacts(gatedChoice.text, protectedText.artifacts);
  const output = applyOutputGuidance(restoredOutput, profile, gate);
  const after = analyzePrompt(output, options);
  const publicFrame = publicIntentFrame(frame, protectedText.artifacts);

  return {
    input: normalized,
    output,
    sections: gatedChoice.sections,
    strategy: gatedChoice.id,
    frame: publicFrame,
    decision: gate.decision,
    confidence: gate.confidence,
    riskReasons: gate.riskReasons,
    metrics: {
      before,
      after,
      tokenDelta: after.tokens - before.tokens,
      tokenReduction: before.tokens ? (before.tokens - after.tokens) / before.tokens : 0,
      valuePerTokenDelta: round(after.valuePerToken - before.valuePerToken),
      protectedArtifacts: protectedText.artifacts.length,
      strategy: gatedChoice.id,
      decision: gate.decision,
      confidence: gate.confidence,
      riskReasons: gate.riskReasons,
      frame: publicFrame
    }
  };
}

function analyzePrompt(text, options = DEFAULT_OPTIONS) {
  const normalized = normalizeInput(text);
  const artifacts = detectArtifacts(normalized);
  const lines = normalized.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const lower = normalized.toLowerCase();
  const tokens = estimateTokens(normalized);
  const constraints = lines.filter((line) => CONSTRAINT_HINTS.test(line));
  const deliverables = lines.filter((line) => DELIVERABLE_HINTS.test(line));
  const structureHeadings = (normalized.match(/(^|\n)\s*(task|goal|context|must|constraints|output|deliverable|quality bar|requirements)\s*:/gi) || []).length;
  const actionWords = (lower.match(/\b(analyze|answer|build|calculate|classify|compare|create|debug|design|draft|estimate|explain|extract|find|fix|generate|improve|make|optimize|plan|produce|reduce|refactor|review|rewrite|ship|summarize|test|verify|write|preserve|protect|measure|return)\b/g) || []).length;
  const specificTerms = (normalized.match(/\b[A-Z][A-Za-z0-9_.-]*\b|`[^`]+`|https?:\/\/\S+|\d{4}-\d{2}-\d{2}/g) || []).length;
  const wasteCount = WASTE_PATTERNS.reduce((sum, pattern) => sum + countMatches(normalized, pattern), 0);
  const intentScore = Math.min(12, Math.max(1, actionWords + deliverables.length * 2 + specificTerms));
  const structureScore = Math.min(10, structureHeadings * 2 + Math.min(lines.length, 4));
  const artifactScore = Math.min(10, artifacts.length * 2);
  const constraintScore = Math.min(10, constraints.length * 2);
  const wastePenalty = Math.min(8, wasteCount);
  const qualityScore = Math.max(1, intentScore + structureScore + artifactScore + constraintScore - wastePenalty);

  return {
    tokens,
    characters: normalized.length,
    qualityScore,
    valuePerToken: round(qualityScore / Math.max(tokens, 1)),
    intent: { score: intentScore, actionWords },
    structure: { score: structureScore, headings: structureHeadings },
    constraints: { count: constraints.length, examples: constraints.slice(0, 4) },
    deliverables: { count: deliverables.length, examples: deliverables.slice(0, 4) },
    artifacts: { count: artifacts.length, examples: artifacts.slice(0, 5).map((item) => item.value) },
    waste: { count: wasteCount }
  };
}

function protectArtifacts(text) {
  const artifacts = [];
  let protectedText = text;

  const protect = (kind, pattern) => {
    protectedText = protectedText.replace(pattern, (match) => {
      const token = `__PRISM_ARTIFACT_${artifacts.length}__`;
      artifacts.push({ kind, token, value: match });
      return token;
    });
  };

  protect("fenced-code", /```[\s\S]*?```/g);
  protect("json-block", /(^|\n)\s*\{[\s\S]{12,}?\}\s*(?=\n|$)/g);
  protect("inline-code", /`[^`\n]+`/g);
  protect("url", /https?:\/\/[^\s)\]}>"']+/g);
  protect("double-quoted", /"([^"\\]|\\.)*"/g);
  protect("single-quoted", /'([^'\\]|\\.)*'/g);
  protect("date", /\b\d{4}-\d{2}-\d{2}\b/g);
  protect("file-path", /(?:~|\/Users|\/[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_. -]+)+\.[A-Za-z0-9]+/g);
  protect("code-statement", /^[ \t]*(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^;\n]*\);?[ \t]*$/gm);

  return { text: protectedText, artifacts };
}

function restoreArtifacts(text, artifacts) {
  return artifacts.reduce((result, artifact) => result.split(artifact.token).join(artifact.value), text);
}

function detectArtifacts(text) {
  return protectArtifacts(text).artifacts;
}

function normalizeInput(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function cleanWaste(text) {
  let result = ` ${text} `;
  for (const [pattern, replacement] of WASTE_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  for (const pattern of WASTE_PATTERNS) {
    result = result.replace(pattern, " ");
  }
  return result
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,+/g, ",")
    .replace(/,\s*(?=$|\n)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?]){2,}/g, "$1")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function dedupeLines(text) {
  const seen = new Set();
  return text
    .split(/\n+/)
    .flatMap(splitLogicalSegments)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function dedupePhysicalLines(text) {
  const seen = new Set();
  const lines = [];
  for (const line of String(text || "").split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const key = normalizeComparable(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(trimmed);
  }
  return lines.join("\n");
}

function splitLogicalSegments(line) {
  const normalized = String(line || "").trim();
  if (!normalized) return [];
  return normalized.split(SENTENCE_TASK_BOUNDARY);
}

function buildAdaptiveProfile(lines, artifacts, before, options) {
  const mode = options.mode || DEFAULT_OPTIONS.mode;
  const task = sentenceCase(normalizeTaskText(extractGoal(lines) || lines.find((line) => !isWeakLine(line)) || ""));
  const constraints = compactList(extractConstraints(lines), mode === "concise" ? 2 : 4);
  const output = compactOutputDirective(lines, task, mode, options);
  const artifactTokens = artifacts.map((artifact) => artifact.token);
  const artifactLines = lines.filter((line) => artifactTokens.some((token) => line.includes(token)));
  const contextSource =
    lines
      .filter((line) => line !== task)
      .filter((line) => !sameMeaning(line, task))
      .filter((line) => !sameMeaning(normalizeTaskText(line), task))
      .filter((line) => !constraints.some((constraint) => line.includes(constraint) || constraint.includes(line)))
      .filter((line) => !sameMeaning(line, output))
      .filter((line) => !isOutputDirective(line))
      .filter((line) => !isWeakLine(line) || artifactTokens.some((token) => line.includes(token)));
  const context = compactContextList(contextSource, before.tokens > 120 ? 4 : 2, artifactTokens);
  const contextHasProblemSignal = context.some((line) => /\b(problem|issue|current|because|goal|north star|failure|bug|regression)\b/i.test(line));
  const must = [...constraints];
  if (artifactTokens.length && !must.some((line) => /artifact|exact|preserve|keep/i.test(line))) {
    must.push("preserve exact artifacts");
  }

  return {
    mode,
    task,
    output,
    context: includeMissingArtifacts(context, artifactLines, artifactTokens),
    must: compactList(must, mode === "concise" ? 3 : 5),
    artifactTokens,
    artifactLines,
    requiresContext: (context.length > 1 && before.tokens > 60) || (contextHasProblemSignal && before.tokens > 22),
    hasWaste: before.waste.count > 0,
    isSimpleCleanRequest:
      artifacts.length === 0 &&
      constraints.length === 0 &&
      context.length === 0 &&
      lines.length <= 2 &&
      estimateTokens(lines.join(" ")) <= 18 &&
      hasClearTaskAction(task),
    isTinyClear:
      before.tokens <= 16 &&
      before.waste.count === 0 &&
      artifacts.length === 0 &&
      constraints.length === 0 &&
      lines.length <= 1,
  };
}

function buildIntentFrame(profile, lines, artifacts, before) {
  const taskType = detectTaskType(profile.task, lines);
  const decisionCriteria = taskType === "decision"
    ? extractDecisionCriteria(lines, profile)
    : [];
  const riskReasons = intentRiskReasons(profile, lines, before, taskType);
  return {
    task: profile.task,
    taskType,
    audience: extractAudience(lines),
    context: profile.context,
    constraints: profile.must,
    artifacts: artifacts.map((artifact) => artifact.token),
    output: profile.output,
    decisionCriteria,
    ambiguityRisk: riskReasons.length ? "high" : "low",
    riskReasons
  };
}

function publicIntentFrame(frame, artifacts) {
  const restore = (value) => restoreArtifacts(value, artifacts);
  return {
    ...frame,
    task: restore(frame.task),
    context: frame.context.map(restore),
    constraints: frame.constraints.map(restore),
    artifacts: artifacts.map((artifact) => artifact.value),
    output: restore(frame.output),
    decisionCriteria: frame.decisionCriteria.map(restore),
  };
}

function applyIntentFrameToProfile(profile, frame) {
  profile.intentFrame = frame;
  if (frame.taskType === "decision" && frame.decisionCriteria.length) {
    profile.context = compactUniqueList([...profile.context, ...frame.decisionCriteria], profile.mode === "concise" ? 3 : 5);
    profile.requiresContext = true;
  }
  if (frame.ambiguityRisk === "high") profile.requiresContext = false;
}

function evaluateRewriteGate(profile, frame, before, chosen) {
  const riskReasons = [...frame.riskReasons];
  let confidence = 0.72;

  if (frame.taskType === "unknown") confidence -= 0.18;
  if (riskReasons.includes("vague task")) confidence -= 0.38;
  if (riskReasons.includes("missing task")) confidence -= 0.44;
  if (frame.taskType === "decision" && frame.decisionCriteria.length) confidence += 0.14;
  if (profile.must.length) confidence += 0.06;
  if (profile.artifactTokens.length) confidence += 0.06;
  if (before.tokens > 28 && profile.context.length) confidence += 0.05;
  if (chosen.id !== "plain") confidence += 0.04;

  confidence = round(clampNumber(confidence, 0.05, 0.98));

  let decision = "apply";
  if (riskReasons.length && confidence < 0.5) {
    decision = "abstain";
  } else if (profile.isTinyClear || (profile.isSimpleCleanRequest && !profile.must.length && !profile.context.length)) {
    decision = "minimal";
  }

  return { decision, confidence, riskReasons };
}

function applyRewriteGate(gate, chosen, protectedOriginal) {
  if (gate.decision === "abstain") {
    return {
      id: "abstain",
      text: protectedOriginal,
      sections: { format: "abstain" }
    };
  }
  return chosen;
}

function detectTaskType(task, lines) {
  const text = [task, ...lines].join(" ").toLowerCase();
  if (/\b(decide|choose|recommend|compare|trade[-\s]?offs?|between| vs\.? |versus)\b/.test(` ${text} `)) return "decision";
  if (/\b(debug|bug|error|fails?|failure|throws?|exception|mismatch|regression|broken)\b/.test(text)) return "debugging";
  if (/\b(summarize|summary|tl;dr)\b/.test(text)) return "summarization";
  if (/\b(email|message|copy|tone|voice|draft|rewrite)\b/.test(text)) return "writing";
  if (/\b(code|function|api|sql|migration|component|refactor|test|typescript|javascript|python)\b/.test(text)) return "coding";
  if (/\b(research|analyze|analysis|sources?|estimate|evaluate)\b/.test(text)) return "analysis";
  if (/\b(explain|teach|beginner|what is|how does)\b/.test(text)) return "explanation";
  if (TASK_VERBS.test(text)) return "general";
  return "unknown";
}

function extractDecisionCriteria(lines, profile) {
  const criteria = [];
  for (const line of lines) {
    if (!line || sameMeaning(line, profile.task) || sameMeaning(normalizeTaskText(line), profile.task) || isOutputDirective(line)) continue;
    if (profile.must.some((must) => line.includes(must) || must.includes(line))) continue;
    if (/\b(cost|price|budget|solo|team|auth|database|query|privacy|speed|latency|risk|scale|criteria|matters?|important|need|needs|must|should|prefer|priority|constraint)\b/i.test(line)) {
      criteria.push(trimTerminalPunctuation(line));
    }
  }
  return compactList(criteria, 4);
}

function extractAudience(lines) {
  const text = lines.join(" ");
  const match = text.match(/\bfor\s+(?:an?|the)?\s*([A-Za-z][A-Za-z0-9 -]{2,48}?)(?:[,.]|$|\s+(?:about|with|who|that|and|but)\b)/i);
  return match ? trimTerminalPunctuation(match[1].trim()) : "";
}

function intentRiskReasons(profile, lines, before, taskType) {
  const reasons = [];
  if (!profile.task) reasons.push("missing task");
  const taskWords = profile.task.split(/\s+/).filter(Boolean);
  const vagueTask = taskWords.length <= 4 &&
    /\b(make|fix|improve|better|this|it|thing|stuff|help)\b/i.test(profile.task) &&
    !profile.artifactTokens.length &&
    !profile.must.length &&
    before.tokens <= 12;
  if (vagueTask) reasons.push("vague task");
  return [...new Set(reasons)];
}

function includeMissingArtifacts(context, artifactLines, artifactTokens) {
  const next = [...context];
  for (const line of artifactLines) {
    const alreadyIncluded = artifactTokens
      .filter((token) => line.includes(token))
      .every((token) => next.some((item) => item.includes(token)));
    if (!alreadyIncluded) next.push(line);
  }
  return compactList(next, 5);
}

function buildAdaptiveCandidates(profile, cleaned, options) {
  const plain = normalizePlainCandidate(cleaned, profile);
  const candidates = [{
    id: "plain",
    text: plain,
    sections: { format: "plain" },
  }];
  if (!profile.task) return candidates;

  const taskOnly = [
    `Task: ${trimTerminalPunctuation(profile.task)}`,
    profile.output ? `Output: ${profile.output}` : "",
  ].filter(Boolean).join("\n");
  candidates.push({
    id: "task-output",
    text: taskOnly,
    sections: { format: "task-output", task: profile.task, output: profile.output },
  });

  if (profile.must.length) {
    const constrained = [
      `Task: ${trimTerminalPunctuation(profile.task)}`,
      `Must: ${joinCompact(profile.must)}`,
      profile.output ? `Output: ${profile.output}` : "",
    ].filter(Boolean).join("\n");
    candidates.push({
      id: "task-must-output",
      text: constrained,
      sections: { format: "task-must-output", task: profile.task, must: profile.must, output: profile.output },
    });
  }

  if (profile.context.length && (profile.requiresContext || profile.context.length > 1 || estimateTokens(cleaned) > 70 || profile.artifactTokens.length)) {
    const withContext = [
      `Task: ${trimTerminalPunctuation(profile.task)}`,
      `Context: ${joinCompact(profile.context)}`,
      profile.must.length ? `Must: ${joinCompact(profile.must)}` : "",
      profile.output ? `Output: ${profile.output}` : "",
    ].filter(Boolean).join("\n");
    candidates.push({
      id: profile.must.length ? "task-context-must-output" : "task-context-output",
      text: withContext,
      sections: { format: "task-context", task: profile.task, context: profile.context, must: profile.must, output: profile.output },
    });
  }

  return candidates.map((candidate) => ({
    ...candidate,
    text: ensureArtifacts(candidate.text, profile),
  }));
}

function ensureArtifacts(text, profile) {
  const missingLines = profile.artifactLines.filter((line) => {
    const tokens = profile.artifactTokens.filter((token) => line.includes(token));
    return tokens.some((token) => !text.includes(token));
  });
  if (!missingLines.length) return text;
  return [
    text,
    `Artifacts: ${joinCompact(missingLines)}`,
  ].filter(Boolean).join("\n");
}

function chooseAdaptiveCandidate(candidates, before, artifacts, profile) {
  const restored = candidates.map((candidate) => {
    const text = restoreArtifacts(candidate.text, artifacts);
    const analysis = analyzePrompt(text);
    const tokenGrowth = analysis.tokens - before.tokens;
    const growthRatio = tokenGrowth / Math.max(before.tokens, 1);
    const score = analysis.valuePerToken - Math.max(0, growthRatio) * 0.18;
    return { ...candidate, analysis, tokenGrowth, score };
  });

  const plain = restored.find((candidate) => candidate.id === "plain") || restored[0];
  if (profile.isTinyClear) return plain;
  if (
    profile.isSimpleCleanRequest &&
    plain.analysis.waste.count === 0 &&
    plain.analysis.tokens <= before.tokens
  ) {
    return plain;
  }

  const allowedGrowth = profile.must.length || profile.artifactTokens.length
    ? Math.max(10, Math.ceil(before.tokens * 0.35))
    : Math.max(6, Math.ceil(before.tokens * 0.25));
  const viable = restored.filter((candidate) => {
    if (candidate.id === "task-output" && (profile.must.length || profile.requiresContext)) return false;
    return candidate.id === "plain" || candidate.tokenGrowth <= allowedGrowth;
  });
  if (profile.intentFrame?.taskType === "decision" && profile.intentFrame.decisionCriteria.length) {
    const criteriaCandidate = viable.find((candidate) => candidate.id === "task-context-output" || candidate.id === "task-context-must-output");
    if (criteriaCandidate) return criteriaCandidate;
  }
  viable.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.01) return b.score - a.score;
    return a.analysis.tokens - b.analysis.tokens;
  });

  const best = viable[0] || plain;
  if (best.id !== "plain") return best;

  const wasteRemoved = before.waste.count > best.analysis.waste.count;
  const tokenReduced = best.analysis.tokens < before.tokens;
  return wasteRemoved || tokenReduced ? best : plain;
}

function compactOutputDirective(lines, task, mode, options = DEFAULT_OPTIONS) {
  const explicit = lines
    .map(trimTerminalPunctuation)
    .find((line) =>
      !sameMeaning(line, task) &&
      /^(return|output|format|provide|give|deliver)\b/i.test(line)
    );
  if (explicit) return compactOutputText(explicit);
  const bulletCount = lines
    .map(trimTerminalPunctuation)
    .find((line) => /\b(?:in|as|return)\s+\d+\s+bullets?\b/i.test(line))
      ?.match(/\b(\d+)\s+bullets?\b/i)?.[0];
  if (bulletCount) return bulletCount;
  return defaultOutputGuidanceText(options);
}

function compactOutputText(text) {
  return String(text || "")
    .replace(/^(return|output|format|provide|give|deliver)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]+$/u, "");
}

function defaultOutputGuidanceText(options = DEFAULT_OPTIONS) {
  if (options.defaultOutputGuidance === false) return "";
  return compactOutputText(options.outputGuidanceText || DEFAULT_OPTIONS.outputGuidanceText);
}

function applyOutputGuidance(text, profile, gate) {
  const output = String(text || "").trim();
  if (!output || gate?.decision === "abstain" || !profile?.output) return output;
  if (/(^|\s)Output\s*:/i.test(output)) return output;
  return `${output}\nOutput: ${profile.output}`;
}

function joinCompact(items) {
  return items
    .map((item) => trimTerminalPunctuation(item))
    .filter(Boolean)
    .join("; ");
}

function sameMeaning(a, b) {
  return normalizeComparable(a) === normalizeComparable(b);
}

function normalizeComparable(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim();
}

function extractGoal(lines) {
  const ranked = lines
    .map((line, index) => ({ line, score: taskLineScore(line, index) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const meaningful = ranked[0]?.line || lines.find((line) => {
    const restored = line.toLowerCase();
    return restored.length > 3 && !restored.startsWith("__prism_artifact_") && !isWeakLine(line);
  });
  if (!meaningful) return "";

  const firstSentence = meaningful.split(/(?<=[.!?])\s+/)[0] || meaningful;
  return normalizeTaskText(firstSentence.replace(/\s+\bbut\s+(do not|keep|preserve|ensure|must)\b[\s\S]*$/i, ""));
}

function taskLineScore(line, index) {
  const text = String(line || "").trim();
  const lower = text.toLowerCase();
  if (!text || isWeakLine(text) || /^__prism_artifact_\d+__$/i.test(text)) return -1;
  if (/^(do not|don't|must|keep|preserve|without|never|only|avoid|use|ensure|protect)\b/i.test(text)) return -1;
  if (isOutputDirective(text)) return -1;

  let score = index * 0.1;
  if (TASK_START.test(text)) score += 8;
  if (/^(i need|need|i want|want)\b/i.test(text)) score += 5;
  if (DELIVERABLE_HINTS.test(text)) score += 2;
  if (TASK_VERBS.test(text)) score += 1;
  if (/^(i am|i'm|for context|the goal|the current|current|this is|the background)\b/i.test(lower)) score -= 4;
  return score;
}

function extractConstraints(lines) {
  return lines
    .filter((line) => CONSTRAINT_HINTS.test(line) && !isOutputDirective(line))
    .map((line) => line.match(/\b(do not|don't|must|keep|preserve|without|never|only|avoid|use|ensure|protect)\b[\s\S]*$/i)?.[0] || line)
    .map(trimTerminalPunctuation)
    .filter((line) => !isSoftOutputPreference(line));
}

function isOutputDirective(line) {
  return /^(return|output|format|provide|give|deliver)\b/i.test(String(line || "").trim());
}

function compactList(items, max) {
  const cleaned = items
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return cleaned.slice(0, max);
}

function compactUniqueList(items, max) {
  const out = [];
  for (const item of items.map((value) => String(value || "").trim()).filter(Boolean)) {
    if (out.some((existing) => sameMeaning(existing, item))) continue;
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function compactContextList(items, max, artifactTokens = []) {
  const cleaned = items
    .map((item, index) => ({ text: String(item || "").trim(), index }))
    .filter((item) => item.text);
  return cleaned
    .map((item) => ({ ...item, score: contextLineScore(item.text, item.index, artifactTokens) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.text);
}

function contextLineScore(line, index, artifactTokens) {
  const text = String(line || "");
  let score = index * 0.05;
  if (artifactTokens.some((token) => text.includes(token))) score += 10;
  if (/\b(goal|north star|value|quality|token|current|version|problem|issue|users?|because|waste|template|dynamic|method)\b/i.test(text)) score += 4;
  if (/^(i want|want|need)\b/i.test(text)) score += 2;
  if (/^(i am|i'm|for context|this is|the background)\b/i.test(text)) score -= 2;
  return score;
}

function trimTerminalPunctuation(text) {
  return String(text || "").trim().replace(/[.]+$/u, "");
}

function normalizeTaskText(text) {
  const normalized = String(text || "")
    .trim()
    .replace(/^(?:what\s+)?i\s+(?:want|need)\s+(?:you\s+)?(?:to\s+do\s+)?(?:now|next)?\s*:?\s*/i, "")
    .replace(/^to\s+(?=\w)/i, "")
    .replace(/^need\s+you\s+to\s+/i, "")
    .replace(/^need\s+to\s+/i, "")
    .replace(/^(?:can|could|would)\s+you\s+/i, "")
    .replace(/^please\s+/i, "")
    .replace(/^tell me how many (.+?) there (?:are|were|will be) (?:yearly|annually|per year|each year)$/i, "how many $1 occur each year")
    .replace(/^tell me how many (.+)$/i, "how many $1")
    .trim();
  return trimTerminalPunctuation(normalized);
}

function normalizePlainCandidate(text, profile) {
  const trimmed = normalizeTaskText(String(text || "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,+/g, ",")
    .replace(/,\s*(?=$|\n)/g, "")
    .trim());
  if (profile?.isSimpleCleanRequest) return sentenceCase(trimmed);
  return trimTerminalPunctuation(trimmed);
}

function hasClearTaskAction(text) {
  return TASK_START.test(text) || TASK_VERBS.test(text) || /^(how|what|why|when|where|who|which)\b/i.test(text);
}

function isSoftOutputPreference(text) {
  const value = String(text || "").trim();
  if (!/\b(?:keep|make|be)?\s*(?:it\s+)?(?:short|brief|concise|direct|not too long)\b/i.test(value)) return false;
  return !/\b(do not|don't|must|preserve|without|never|only|avoid|use|ensure|protect|private|exact)\b/i.test(value);
}

function sentenceCase(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function isWeakLine(line) {
  const text = String(line || "").toLowerCase();
  if (/__prism_artifact_\d+__/.test(text)) return false;
  const hasTaskVerb = /\b(build|make|create|write|fix|improve|reduce|preserve|protect|measure|return|ship|test|verify|optimize|generate)\b/.test(text);
  if (hasTaskVerb) return false;
  return /^(help me|here is|and the file|the file|thanks|thank you|ok|okay)\b/.test(text) || text.length < 4;
}

function estimateTokens(text) {
  const normalized = normalizeInput(text);
  if (!normalized) return 0;
  const words = normalized.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) || [];
  return Math.max(1, Math.ceil((words.length + normalized.length / 5) / 2));
}

function countMatches(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const copy = new RegExp(pattern.source, flags);
  return (text.match(copy) || []).length;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const DEFAULT_MARGIN = 16;
const DEFAULT_PADDING = 8;
const DEFAULT_RADIUS = 28;
const TALL_COMPOSER_HEIGHT = 96;
const TALL_RADIUS_CAP = 56;
const TALL_FALLBACK_RADIUS = 48;

function placeOverlay({ composerRect, viewport, padding = DEFAULT_PADDING, margin = DEFAULT_MARGIN }) {
  const maxWidth = Math.max(0, viewport.width - margin * 2);
  const width = Math.min(Math.max(320, composerRect.width + padding * 2), maxWidth);
  let x = composerRect.x - padding;
  x = Math.max(margin, Math.min(x, viewport.width - margin - width));

  const height = Math.max(64, composerRect.height + padding * 2);
  let y = composerRect.y - padding;
  y = Math.max(margin, Math.min(y, viewport.height - margin - height));

  return roundRect({ x, y, width, height });
}

function collectNativeHoles({ overlayRect, controlRects, viewport, padding = 4, gap = 8 }) {
  const inside = controlRects
    .map((rect) => expandRect(rect, padding))
    .map((rect) => clampRectToViewport(rect, viewport))
    .filter((rect) => rect.width > 8 && rect.height > 8)
    .filter((rect) => rectsIntersect(rect, overlayRect))
    .map((rect) => ({
      x: Math.max(rect.x, overlayRect.x),
      y: Math.max(rect.y, overlayRect.y),
      width: Math.min(rect.x + rect.width, overlayRect.x + overlayRect.width) - Math.max(rect.x, overlayRect.x),
      height: Math.min(rect.y + rect.height, overlayRect.y + overlayRect.height) - Math.max(rect.y, overlayRect.y)
    }))
    .filter((rect) => rect.width > 8 && rect.height > 8);

  return mergeNearbyRects(inside, gap).map((rect) => ({
    ...rect,
    radius: Math.min(DEFAULT_RADIUS, rect.height / 2, rect.width / 2)
  }));
}

function mergeNearbyRects(rects, gap = 8) {
  const expanded = rects.map((rect) => expandRect(rect, 4)).sort((a, b) => a.x - b.x || a.y - b.y);
  const merged = [];

  for (const rect of expanded) {
    const last = merged[merged.length - 1];
    if (!last || !shouldMerge(last, rect, gap)) {
      merged.push({ ...rect });
      continue;
    }

    const right = Math.max(last.x + last.width, rect.x + rect.width);
    const bottom = Math.max(last.y + last.height, rect.y + rect.height);
    last.x = Math.min(last.x, rect.x);
    last.y = Math.min(last.y, rect.y);
    last.width = right - last.x;
    last.height = bottom - last.y;
  }

  return merged.map(roundRect);
}

function clampRectToViewport(rect, viewport) {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  return roundRect({
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y)
  });
}

function buildMaskPath({ overlayRect, holes = [], radius = DEFAULT_RADIUS }) {
  const outer = roundedRectPath(overlayRect, radius, "left");
  const holePaths = holes.map((hole) => roundedRectPath(hole, hole.radius ?? radius, "top"));
  return [outer, ...holePaths].join(" ");
}

function resolveSkinRadius({ hostRadius = 0, width = 0, height = 0 } = {}) {
  const numericWidth = finiteNumber(width);
  const numericHeight = finiteNumber(height);
  const maxPhysicalRadius = Math.max(0, Math.min(numericWidth / 2, numericHeight / 2));
  if (!maxPhysicalRadius) return 0;

  const isTall = numericHeight >= TALL_COMPOSER_HEIGHT;
  const maxUsefulRadius = isTall ? Math.min(TALL_RADIUS_CAP, maxPhysicalRadius) : maxPhysicalRadius;
  const numericHostRadius = finiteNumber(hostRadius);

  if (numericHostRadius > 0) {
    return round(Math.min(numericHostRadius, maxUsefulRadius));
  }

  if (isTall) {
    return round(Math.min(TALL_FALLBACK_RADIUS, maxUsefulRadius));
  }

  return round(Math.min(Math.max(24, numericHeight / 2), maxUsefulRadius));
}

function createReferenceNativeHoles({ overlayRect, left = true, right = true }) {
  const holes = [];
  const centerY = overlayRect.height / 2;
  const circle = Math.min(48, Math.max(40, overlayRect.height - 24));
  const y = Math.max(6, centerY - circle / 2);

  if (left && overlayRect.width >= 260) {
    holes.push({
      x: 10,
      y,
      width: circle,
      height: circle,
      radius: circle / 2
    });
  }

  if (right && overlayRect.width >= 420) {
    const margin = 10;
    const gap = 8;
    const action = circle;
    const modelWidth = Math.min(168, Math.max(132, overlayRect.width * 0.18));
    const sendX = overlayRect.width - margin - action;
    const voiceX = sendX - gap - action;
    const modelX = Math.max(overlayRect.width * 0.58, voiceX - gap - modelWidth);

    holes.push(
      { x: modelX, y, width: modelWidth, height: circle, radius: circle / 2 },
      { x: voiceX, y, width: action, height: circle, radius: action / 2 },
      { x: sendX, y, width: action, height: circle, radius: action / 2 }
    );
  }

  return holes.map((hole) => ({
    ...roundRect(hole),
    radius: round(hole.radius)
  }));
}

function roundedRectPath(rect, radius = DEFAULT_RADIUS, start = "left") {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  const x = round(rect.x);
  const y = round(rect.y);
  const w = round(rect.width);
  const h = round(rect.height);
  const right = round(x + w);
  const bottom = round(y + h);
  const centerX = round(x + w / 2);
  const centerY = round(y + h / 2);

  if (start === "top") {
    return [
      `M ${centerX} ${y}`,
      `H ${right - r}`,
      `Q ${right} ${y} ${right} ${y + r}`,
      `V ${bottom - r}`,
      `Q ${right} ${bottom} ${right - r} ${bottom}`,
      `H ${x + r}`,
      `Q ${x} ${bottom} ${x} ${bottom - r}`,
      `V ${y + r}`,
      `Q ${x} ${y} ${x + r} ${y}`,
      "Z"
    ].join(" ");
  }

  return [
    `M ${x} ${centerY}`,
    `V ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    `H ${right - r}`,
    `Q ${right} ${y} ${right} ${y + r}`,
    `V ${bottom - r}`,
    `Q ${right} ${bottom} ${right - r} ${bottom}`,
    `H ${x + r}`,
    `Q ${x} ${bottom} ${x} ${bottom - r}`,
    `V ${centerY}`,
    "Z"
  ].join(" ");
}

function shouldMerge(a, b, gap) {
  const horizontalGap = b.x - (a.x + a.width);
  const verticalOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const sameRow = verticalOverlap >= Math.min(a.height, b.height) * 0.35;
  return sameRow && horizontalGap <= gap;
}

function expandRect(rect, amount) {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2
  };
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function roundRect(rect) {
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height)
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

globalThis.PrismCore = {
  createPrismEngine,
  prismPrompt,
  analyzePrompt,
  protectArtifacts,
  restoreArtifacts,
  placeOverlay,
  collectNativeHoles,
  createReferenceNativeHoles,
  mergeNearbyRects,
  clampRectToViewport,
  buildMaskPath,
  roundedRectPath,
  resolveSkinRadius
};
globalThis.PrismOptimizer = {
  optimize(prompt, options = {}) {
    const result = prismPrompt(prompt, options);
    return {
      optimizedPrompt: result.output,
      result,
      metrics: result.metrics
    };
  }
};
})();
