import test from "node:test";
import assert from "node:assert/strict";

import { parseStructuredOutput } from "../plugins/grok/scripts/lib/grok.mjs";

const REVIEW = {
  verdict: "needs-attention",
  summary: "Do not ship yet.",
  findings: [
    {
      severity: "high",
      title: "Pool charge happens after materialization",
      body: "The batch is already allocated before try_grow runs.",
      file: "src/provider/scan.rs",
      line_start: 1051,
      line_end: 1073,
      confidence: 0.92,
      recommendation: "Reserve before materialization."
    }
  ],
  next_steps: ["Move the reservation across the inner poll."]
};

function looksLikeReview(value) {
  return Boolean(value) && typeof value.verdict === "string" && Array.isArray(value.findings);
}

test("Grok's own structuredOutput wins over the text stream", () => {
  const parsed = parseStructuredOutput("this text is not even JSON", {
    structuredOutput: REVIEW
  });

  assert.equal(parsed.parseError, null);
  assert.deepEqual(parsed.parsed, REVIEW);
});

/**
 * The failure that made reviews unusable: under a JSON schema, Grok's narration
 * between tool calls is itself JSON, so the captured output is several complete
 * objects glued together. Only the last one is the real answer.
 */
test("a run of concatenated JSON drafts resolves to the final object", () => {
  const drafts = [
    { verdict: "needs-attention", summary: "Review in progress.", findings: [], next_steps: [] },
    { verdict: "needs-attention", summary: "Still investigating.", findings: [], next_steps: [] },
    REVIEW
  ]
    .map((value) => JSON.stringify(value))
    .join("");

  const parsed = parseStructuredOutput(drafts, { shapeCheck: looksLikeReview });

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.summary, "Do not ship yet.");
  assert.equal(parsed.parsed.findings.length, 1);
});

test("the final message segment is preferred over earlier drafts", () => {
  const segments = [
    JSON.stringify({ verdict: "approve", summary: "Nothing yet.", findings: [], next_steps: [] }),
    JSON.stringify(REVIEW)
  ];

  const parsed = parseStructuredOutput(segments.join("\n\n"), {
    segments,
    shapeCheck: looksLikeReview
  });

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.summary, "Do not ship yet.");
});

test("prose wrapped around the object does not defeat parsing", () => {
  const text = `Here is what I found.\n\n\`\`\`json\n${JSON.stringify(REVIEW)}\n\`\`\`\n\nLet me know if you want fixes.`;
  const parsed = parseStructuredOutput(text, { shapeCheck: looksLikeReview });

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.findings.length, 1);
});

/**
 * Braces inside string values must not be read as structure — a recommendation
 * that mentions `{ ... }` would otherwise split the object in the wrong place.
 */
test("braces inside string values do not confuse the scanner", () => {
  const review = {
    ...REVIEW,
    summary: 'Guard the `if (x) { return null; }` branch and the "}" literal.'
  };
  const parsed = parseStructuredOutput(JSON.stringify(review), { shapeCheck: looksLikeReview });

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.summary, review.summary);
});

/**
 * When the output token budget cuts the JSON mid-object, every finding emitted
 * before the cut is still there. Throwing the whole review away loses a run
 * that may have taken minutes.
 */
test("a truncated object is salvaged down to its complete findings", () => {
  const full = {
    ...REVIEW,
    findings: [
      REVIEW.findings[0],
      { ...REVIEW.findings[0], title: "Second finding", severity: "medium" },
      { ...REVIEW.findings[0], title: "Third finding", severity: "low" }
    ]
  };
  const serialized = JSON.stringify(full);
  // Cut partway through the third finding's body.
  const truncated = serialized.slice(0, serialized.indexOf("Third finding") + 20);

  const parsed = parseStructuredOutput(truncated, {
    stopReason: "max_tokens",
    shapeCheck: looksLikeReview
  });

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.recovered, "truncated-json");
  assert.equal(parsed.parsed.verdict, "needs-attention");
  assert.ok(parsed.parsed.findings.length >= 2, "complete findings before the cut must survive");
  assert.equal(parsed.parsed.findings[0].title, REVIEW.findings[0].title);
});

test("a truncated string value is closed rather than dropping the object", () => {
  const serialized = JSON.stringify(REVIEW);
  const truncated = serialized.slice(0, serialized.indexOf("Do not ship") + 6);

  const parsed = parseStructuredOutput(truncated, { stopReason: "max_tokens" });

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "needs-attention");
});

test("an object of the wrong shape is still returned rather than lost", () => {
  const parsed = parseStructuredOutput(JSON.stringify({ notes: "unexpected shape" }), {
    shapeCheck: looksLikeReview
  });

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.notes, "unexpected shape");
});

test("an early truncation reports the stop reason instead of a generic parse error", () => {
  const parsed = parseStructuredOutput("I was still thinking when I ran out of", {
    stopReason: "max_tokens"
  });

  assert.equal(parsed.parsed, null);
  assert.match(parsed.parseError, /max_tokens/);
  assert.match(parsed.parseError, /cut off/i);
});

test("empty output reports the underlying failure", () => {
  const parsed = parseStructuredOutput("", { failureMessage: "grok exited with code 1" });

  assert.equal(parsed.parsed, null);
  assert.equal(parsed.parseError, "grok exited with code 1");
});
