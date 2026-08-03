import test from "node:test";
import assert from "node:assert/strict";

import {
  renderCancelReport,
  renderNativeReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "../plugins/grok/scripts/lib/render.mjs";

test("renderSetupReport includes grok checks", () => {
  const text = renderSetupReport({
    ready: true,
    node: { detail: "v22" },
    npm: { detail: "10" },
    grok: { detail: "grok 0.2.0" },
    auth: { detail: "Logged in" },
    sessionRuntime: { label: "headless CLI" },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: []
  });
  assert.match(text, /Grok Setup/);
  assert.match(text, /grok: grok 0\.2\.0/);
  assert.match(text, /headless CLI/);
});

test("renderNativeReviewResult shows review body", () => {
  const text = renderNativeReviewResult(
    { status: 0, stdout: "Looks good overall.", stderr: "" },
    { reviewLabel: "Review", targetLabel: "working tree" }
  );
  assert.match(text, /Grok Review/);
  assert.match(text, /Looks good overall/);
});

test("renderTaskResult returns raw output", () => {
  const text = renderTaskResult({ rawOutput: "Done.\n" }, { title: "Grok Task" });
  assert.equal(text, "Done.\n");
});

test("renderStatusReport handles empty queue", () => {
  const text = renderStatusReport({
    sessionRuntime: { label: "headless CLI" },
    config: { stopReviewGate: false },
    running: [],
    latestFinished: null,
    recent: [],
    needsReview: false
  });
  assert.match(text, /Grok Status/);
  assert.match(text, /No jobs recorded yet/);
});

test("renderCancelReport mentions job id", () => {
  const text = renderCancelReport({ id: "task-1", title: "Grok Task", summary: "fix it" });
  assert.match(text, /Cancelled task-1/);
  assert.match(text, /\/grok:status/);
});
