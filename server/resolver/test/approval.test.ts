import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApproval, NOT_IMPLEMENTED_APPROVAL_GATE, ApprovalNotWiredError } from "../src/approval.ts";

test("needsApproval: true when payout meets or exceeds the threshold", () => {
  assert.equal(needsApproval(100n, 100n), true);
  assert.equal(needsApproval(101n, 100n), true);
  assert.equal(needsApproval(99n, 100n), false);
});

test("needsApproval: a zero threshold means everything needs approval", () => {
  assert.equal(needsApproval(1n, 0n), true);
  assert.equal(needsApproval(0n, 0n), true);
});

test("NOT_IMPLEMENTED_APPROVAL_GATE throws a clear, typed error rather than silently approving", async () => {
  await assert.rejects(
    () => NOT_IMPLEMENTED_APPROVAL_GATE({ dealSummary: "test", payoutBaseUnits: 1000n, recipient: "0x0000000000000000000000000000000000dead" }),
    ApprovalNotWiredError,
  );
});
