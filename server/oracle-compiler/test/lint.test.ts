import { test } from "node:test";
import assert from "node:assert/strict";
import { lintDealText, lintSourceUrl, lintSourceUrls } from "../src/lint.ts";

test("lintDealText flags subjective words", () => {
  const findings = lintDealText("The work must be of good quality and professional.", true);
  assert.ok(findings.some((f) => f.code === "subjective_word" && f.detail === "good"));
  assert.ok(findings.some((f) => f.code === "subjective_word" && f.detail === "professional"));
});

test("lintDealText flags time words only when there is no concrete deadline", () => {
  const withoutDeadline = lintDealText("Ship the feature promptly.", false);
  assert.ok(withoutDeadline.some((f) => f.code === "time_word_without_timestamp" && f.detail === "promptly"));

  const withDeadline = lintDealText("Ship the feature promptly.", true);
  assert.ok(!withDeadline.some((f) => f.code === "time_word_without_timestamp"));
});

test("lintDealText flags login-required hints", () => {
  const findings = lintDealText("Check the members only dashboard after login.", true);
  assert.ok(findings.some((f) => f.code === "login_required_hint"));
});

test("lintDealText passes clean, objective, deadlined text", () => {
  const findings = lintDealText("acme/widget must publish a GitHub release by 2026-11-01T00:00:00Z.", true);
  assert.deepEqual(findings, []);
});

test("lintSourceUrl rejects non-https, credentialed, and private-host URLs", () => {
  assert.ok(lintSourceUrl("http://example.com").length > 0);
  assert.ok(lintSourceUrl("https://user:pass@example.com").length > 0);
  assert.ok(lintSourceUrl("https://localhost/x").length > 0);
  assert.ok(lintSourceUrl("https://192.168.1.5/x").length > 0);
  assert.ok(lintSourceUrl("not a url").length > 0);
});

test("lintSourceUrl accepts a plain public https URL", () => {
  assert.deepEqual(lintSourceUrl("https://github.com/acme/widget"), []);
});

test("lintSourceUrls aggregates findings across multiple URLs", () => {
  const findings = lintSourceUrls(["https://github.com/acme/widget", "http://insecure.example.com"]);
  assert.equal(findings.length, 1);
});
