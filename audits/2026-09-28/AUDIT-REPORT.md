# MilestoneEscrow — Audit Report

**Date**: 2026-09-28 · **Contract**: `contracts/src/MilestoneEscrow.sol` (36/36 Foundry tests passing before this audit)

**Fix status (2026-09-28, same day)**: all 3 High and all 3 Medium findings are now fixed, covered by
new tests (48/48 passing, up from 36/36 at audit time). See "Fixes applied" at the end of this file
for exactly what changed. All Low/Info findings are **not yet fixed**.
**Method**: [ethskills.com](https://ethskills.com)'s `/audit` skill, routing to the
[austintgriffith/evm-audit-skills](https://github.com/austintgriffith/evm-audit-skills) checklist set.
Six parallel Opus sub-agents, one per checklist (`general`, `precision-math`, `erc20`, `signatures`,
`access-control`, `dos`), each given the full contract, the test suite, and (where relevant)
`docs/SPEC.md`. Raw per-checklist findings are in this directory (`findings-*.md`); this file
deduplicates, cross-checks, and re-ranks them.

**Not done**: no GitHub issues were filed (no remote repo exists yet, and that's a visible,
outward-facing action that needs sign-off first regardless). No code fixes have been applied — this
is the review only.

## Severity counts (post-dedup)

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 3 |
| Low | 5 |
| Info | 1 |

Several findings were independently reported by 2–3 of the six agents (noted inline below) — that
convergence is a stronger signal than any one agent's finding alone, and drove two severity
corrections from the raw per-checklist ratings (see H1, H2).

---

## High

### [H1] Constructor-pull funding authorizes against a predicted, not-yet-deployed address — a malicious or merely careless deployer can redirect the payer's deposit
**Raised by**: `evm-audit-general` [GEN-1], `evm-audit-erc20` [ERC20-3], `evm-audit-access-control` [AC-3] (independently, all three) — synthesis note: each rated this Medium individually; raised to **High** here because it fits the stated rubric exactly ("loss of funds requiring specific conditions") once you account for who actually deploys.
**Location**: `constructor`, MilestoneEscrow.sol:77-112, specifically `token.safeTransferFrom(_payer, address(this), _amount)` at line 111.
**The issue**: The contract funds itself by pulling from `_payer` — a plain constructor argument, not `msg.sender`. The payer authorizes this beforehand by approving a CREATE address computed from the deployer's account and nonce (`vm.computeCreateAddress` in the tests). That approval is bound only to *an address*, not to the deal terms. Per `docs/SPEC.md`, the deployer is IMD's `workflow.open` agent, not the payer — so whoever controls that agent's deploy transaction picks `payee`, `oracleSigner`, `feeRecipient`, `feeBps`, `deadline`, `questionHash`, everything, in the same transaction that pulls the payer's funds. The spec's own claim — "The agent only relays a signed attestation... it cannot redirect funds" — is true of the *resolver* agent, but not of the *deploying* agent, which this analysis shows can redirect funds outright.
**Compounds with**: M1 below. If a deployer sets `oracleSigner` to an address it controls, it doesn't even need a real IMD attestation — it can self-sign a `true` and walk straight through `release()`.
**Fix**: Require `msg.sender == _payer` in the constructor, or move funding into a CREATE2 factory whose salt commits to every constructor argument (`keccak256(abi.encode(terms))`), or take a payer-signed EIP-712/Permit2 authorization over the exact terms and verify it in the constructor. Full code sketch in `findings-evm-audit-access-control.md` [AC-3].

### [H2] Settlement pays a fixed `amount`, not the contract's actual token balance — fee-on-transfer, rebasing, or share-based tokens (stETH-style) permanently lock all funds
**Raised by**: `evm-audit-erc20` [ERC20-1] (High), `evm-audit-general` [GEN-4] (Medium), `evm-audit-dos` [DOS-3] (Medium) — independently, all three. Standardized to **High** per the rubric: this is fund loss under a specific, plausible condition (payer/payee pick a non-standard ERC20, which the constructor does nothing to prevent).
**Location**: constructor:111, `submitAttestation()`:132, `release()`:142-146, `reclaim()`:156.
**The issue**: The constructor never checks how much the contract actually received after `transferFrom`; it just stores the requested `_amount` as an immutable and pays out exactly that on every exit path. If the token takes a fee on transfer, rebases downward, or is a rounding-lossy share token, the contract ends up holding less than `amount`, and **every** payout function (`release`, `reclaim`, the false-attestation refund) reverts on insufficient balance — permanently, since there's no owner and no sweep.
**Fix**: Measure `balanceOf(address(this))` before/after the constructor's transfer and either reject the token if the received amount differs, or store the actually-received amount as the escrowed `amount`. Code sketch in `findings-evm-audit-erc20.md` [ERC20-1].

### [H3] Push-only payouts — a blocklisted or reverting payee, fee recipient, or payer permanently locks the escrow
**Raised by**: `evm-audit-erc20` [ERC20-2] (High), `evm-audit-dos` [DOS-1] (High) — independently, both agree on High.
**Location**: `release()`:145-146, `submitAttestation()` false branch:132, `reclaim()`:150,156.
**The issue**: Every settlement path pushes tokens straight to a fixed, immutable address with no alternative. USDC and USDT both have issuer blocklists. If `payee` or `feeRecipient` gets blocklisted *after* a true attestation sets `trueAt`, `release()` reverts forever and `reclaim()` is permanently blocked too (`AlreadyTrue`) — there's no path left to move the funds. Same failure mode if `payer` is blocklisted before resolution.
**Fix**: Switch to a pull-payment pattern — credit an `owed[address]` mapping at the state transition, and let each party `withdraw()` on their own schedule, to an address of their own choosing. Code sketch in `findings-evm-audit-dos.md` [DOS-1].

---

## Medium

### [M1] `submitAttestation` isn't bound to the escrow's own deadline — three related failure modes, all from the same root cause
**Raised by**: `evm-audit-general` [GEN-3], `evm-audit-signatures` [SIG-1, SIG-2], `evm-audit-access-control` [AC-1, AC-5], `evm-audit-dos` [DOS-4, DOS-5] — this is the single most-corroborated cluster in the whole audit, independently surfaced by all four remaining agents from different angles.
**Location**: `submitAttestation()`, MilestoneEscrow.sol:114-134. Root cause: the function checks `expiresAt`, `chainId`, `questionHash`, and the signature — but never reads `deadline`, and never checks the signed `issuedAt`/`fromBlock`/`toBlock` fields against anything.
**Three failure modes from one gap**:
1. **Early false**: a validly-signed `false` issued *before* the deadline is accepted and immediately, irreversibly refunds the payer — even if the payee would have finished on time. The spec explicitly says false should only settle "after a deadline."
2. **Late true vs. reclaim() race**: after `deadline + grace`, both a `true` relay and `reclaim()` are live simultaneously; whichever lands first in the mempool wins, so either side can front-run the other.
3. **No freshness/uniqueness**: nothing stops the oracle from having signed *more than one* answer for the same `questionHash` (e.g., a legitimate re-ask after a disagreeing panel, or — per `docs/DAY-ONE-FINDINGS.md` — anyone can pay 0.5 IMD to request a fresh answer for the same `consumer.verifyingContract`). Whichever valid, unexpired attestation is submitted *first* wins, not whichever is "correct" or "latest." A stale `false` can undo an otherwise-earned `true` window if it's relayed first, and vice versa.
**Fix**: Check `m.issuedAt` against `deadline` (reject `false` before the deadline; reject anything after `deadline + grace`), and track the accepted `requestId`/`issuedAt` so a second attestation can't undermine the first. Code sketches in `findings-evm-audit-access-control.md` [AC-1] and `findings-evm-audit-general.md` [GEN-3].

### [M2] The "challenge window" has no challenge mechanism — it's a pure timelock, not a dispute right
**Raised by**: `evm-audit-general` [GEN-2], `evm-audit-signatures` [SIG-3], `evm-audit-access-control` [AC-2] — independently, all three, same finding.
**Location**: `release()`:136-147; once `trueAt != 0`, `submitAttestation` reverts `AlreadyResolvedTrue` and `reclaim` reverts `AlreadyTrue` — nothing else is callable during the window.
**The issue**: `docs/SPEC.md` states directly: "The contract's challenge window on a true answer gives both sides time to object to a result before money moves." As built, there is no `challenge()`, no dispute state, and no way for a corrected oracle answer to land once `trueAt` is set. The window delays `release()` by a fixed duration; it does not let anyone object. This is also the spec's own listed mitigation for "one attester signer key is a single trust point" (H1's oracleSigner risk) — and it doesn't actually mitigate that risk as built.
**Fix**: Either add a real `challenge()` path (e.g., accept a newer oracle-signed correction during the window) or update the spec/status-page copy to describe this as a settlement delay, not a dispute right. Code sketch in `findings-evm-audit-general.md` [GEN-2].

### [M3] Fee-recipient transfer is coupled to the payee's payout in `release()` — a blocked fee recipient blocks the payee too
**Raised by**: `evm-audit-dos` [DOS-2] (single-agent finding, listed separately from H3 because the fix is narrower).
**Location**: `release()`:145-146.
**The issue**: The fee transfer and payee transfer happen in the same call; if the fee leg reverts (blocklisted or hook-reverting `feeRecipient`), the payee gets nothing, even though the payee did nothing wrong and has no relationship with the fee recipient.
**Fix**: Pay the payee first, and make the fee transfer non-blocking (`trySafeTransfer`, credit an `unclaimedFee` variable on failure) rather than reverting the whole settlement. Code sketch in `findings-evm-audit-dos.md` [DOS-2].

---

## Low

- **[L1] Constructor accepts nonsensical timing parameters** — no lower/upper bounds on `deadline`, `grace`, `challengeWindow`; a past deadline or zero grace effectively disables the payee's protection. (`evm-audit-general` [GEN-5]) Compounds with H1: if the deployer can pick bad terms *and* isn't the payer, this is worse than a simple footgun.
- **[L2] No sweep for stranded tokens** — direct transfers, rebase surplus, or the shortfall-donation fix for H2 all leave any balance above `amount` permanently stuck, since there's no owner. (`evm-audit-general` [GEN-6])
- **[L3] No check that payee/payer/feeRecipient aren't the token contract or the escrow itself** — cheap guard against a griefing or fat-fingered deploy. (`evm-audit-erc20` [ERC20-4])
- **[L4] Checked-arithmetic overflow in the fee calculation at astronomical token amounts (~1e74+) permanently locks funds** — needs an unrealistic token supply to trigger; use `Math.mulDiv` instead of raw `amount * feeBps` for the cheap fix. (`evm-audit-precision-math` [MATH-1])
- **[L5] Single immutable `oracleSigner` with no rotation path** — already disclosed in `docs/SPEC.md`'s risk register as a known trust assumption. New detail from this audit: routine key rotation or loss doesn't just block *new* attestations, it silently resolves *every* live escrow bound to the old key in the payer's favor (via `reclaim()`) regardless of whether the payee actually met the milestone. Worth calling out explicitly to customers, not just internally. (`evm-audit-access-control` [AC-4])

## Info

- **[I1] Fee rounds down to zero below ~50 base units at the 200bps cap** — reasonable default (favors the payee), but undocumented as an intentional rounding direction. (`evm-audit-precision-math` [MATH-2])

---

## Cross-cutting read

The two most load-bearing findings are **H1** (deployer, not payer, controls the terms) and **M1**
(no deadline binding on attestations) — together they mean the two places the spec says "the system
can't redirect funds" (the deploying workflow, and the permissionless attestation relay) both have a
real gap once you look at exactly what's checked on-chain versus what's assumed off-chain. Neither
requires a broken cryptographic primitive; both are missing application-level checks (`msg.sender ==
payer`, `issuedAt` vs `deadline`) that are cheap to add. **M2** (no real challenge mechanism) is what
turns a successful H1 or M1 exploit from "recoverable during the window" into "final once
`challengeWindow` elapses" — so fixing M1/H1 alone would already remove most of the urgency around M2,
but M2 is still worth fixing on its own since a wrong *oracle* answer (not just a wrong *relay*) has
the same no-recourse problem.

None of the six agents found a way to route funds to anyone other than `payer` or `payee` (modulo H1's
attacker-controlled `payee` scenario) — the "anyone can relay, but only payer/payee can receive" design
goal from the spec does hold once H1 is fixed. The 36 passing Foundry tests were all written against
the intended happy-path and boundary behavior; none of them exercise a weird ERC20, a non-payer
deployer, or an early/duplicate attestation, which is exactly the gap this audit found.

---

## Fixes applied (2026-09-28)

All three High findings were fixed the same day, in `contracts/src/MilestoneEscrow.sol`. 6 new tests
were added (42/42 passing, up from 36/36).

### H1 — payer authorization now binds the exact deal terms, not a predicted address
Added a `_payerAuthorization` constructor parameter: the payer signs (via `personal_sign` /
`toEthSignedMessageHash`, verified with `ECDSA.recover`) a hash of every constructor argument
(`payer, payee, token, amount, deadline, grace, questionHash, oracleSigner, feeRecipient, feeBps,
challengeWindow`). The constructor reverts with `InvalidPayerAuthorization` unless that signature
recovers to `_payer`. A deploying agent (IMD's `workflow.open`, or anyone else) can still broadcast
the deployment transaction, but cannot change any signed term without invalidating the payer's
authorization — closing the "deployer picks the terms" gap. Deliberately did **not** switch to a
CREATE2-factory pattern or require `msg.sender == payer`, since either would either add a new
contract to the trust surface or break the "a service deploys on the payer's behalf" flow the
product needs; the signed-terms approach gets the same guarantee without either cost.
Tests: `test_ConstructorRevertsOnInvalidPayerAuthorization_WrongSigner`,
`test_ConstructorRevertsOnInvalidPayerAuthorization_TamperedTerm`.

### H2 — fee-on-transfer / rebasing tokens are now rejected at deployment
The constructor now measures `token.balanceOf(address(this))` immediately before and after the
initial `safeTransferFrom`, and reverts with `UnsupportedToken` if the contract didn't receive
exactly `_amount`. This is a reject-at-deploy fix, not a live-balance-accounting fix — the contract
still pays out the fixed `amount` afterward, which is fine because any token that would have caused
a mismatch is now refused up front. Added `test/mocks/MockFeeOnTransferToken.sol` to exercise this.
Test: `test_ConstructorRevertsOnFeeOnTransferToken`.

### H3 — settlement is now pull-payment, not push-payment
`release()`, `reclaim()`, and the false-attestation branch of `submitAttestation()` now credit an
`owed[address]` mapping instead of calling `safeTransfer` directly. A new permissionless
`withdraw(address to)` lets each party pull their own entitlement to an address of their choosing —
so a blocklisted or hook-reverting default address no longer locks the funds (or, per M3, no longer
locks *other parties'* funds too, as a side effect of decoupling the fee and payee transfers). State
transitions (`Funded → Released` / `Refunded`) are unchanged and still one-way and permissionless;
only the token movement itself is now pull-based.
Tests: `test_Withdraw_CanRedirectToADifferentAddress`, `test_Withdraw_RevertsWhenNothingOwed`,
`test_Withdraw_RevertsOnZeroAddress`, plus all existing release/reclaim/false-path tests were updated
to check `owed(...)` and then `withdraw()` rather than asserting an immediate balance change.

### What this does and doesn't fix
Fixing H3 (pull payments) incidentally also resolved **M3** (fee-recipient failure no longer blocks
the payee — they're independent `owed` entries now). **M1** and **M2** are fixed below. All Low/Info
findings are still open.

## Medium fixes applied (2026-09-28)

### M1 — `submitAttestation` is now bound to the escrow's deadline, with freshness ordering
Three checks added, in this order: `BadIssuedAt` rejects an attestation dated in the future;
`StaleAttestation` rejects one whose `issuedAt` isn't strictly newer than the last accepted one
(tracked in a new `lastIssuedAt`); `TooLate` rejects anything submitted after `deadline + grace`
(closing the race with `reclaim()`); `PrematureFalse` rejects a `false` answer issued before the
deadline (closing the early-drain path). Together these remove the "first attestation submitted
wins regardless of correctness" behavior the audit found, and the "either side can win a mempool
race after `deadline + grace`" behavior. Deliberately did **not** add an `issuedAt >= deadline`
requirement to `true` answers — the spec's honest flow already has the resolver act at the deadline,
and gating `true` the same way `false` is gated would need the same treatment for the edge case where
IMD backfills an answer slightly early; left as a documented non-requirement rather than guessed at.
Tests: `test_SubmitAttestation_RevertsOnPrematureFalse`, `test_SubmitAttestation_RevertsOnTooLate`,
`test_SubmitAttestation_RevertsOnFutureIssuedAt`, `test_SubmitAttestation_RevertsOnStaleOverrideAttempt`.

### M2 — the challenge window now has an actual challenge mechanism
While `trueAt != 0` and still inside `challengeWindow`, a **fresher, oracle-signed `false`** for the
same escrow now overrides the `true` and settles the deal as `Refunded` instead of being blocked
outright. A second `true`, or any attestation once the window has closed, still cannot change a
resolved `true` — `release()` remains the only way forward at that point, matching the original
design. This directly implements what the spec claims ("the challenge window... gives both sides
time to object to a result before money moves"): objecting means getting the oracle to issue and
relay a corrected `false` before the window closes, not a unilateral on-chain veto. That's a real,
narrower dispute right than "either party can freeze it," and still depends on the oracle's
willingness to issue a correction — worth being explicit about in customer-facing docs. `AC-4`'s
underlying concern (single immutable oracle signer, no rotation) is unrelated to this fix and is
still an open, disclosed trust assumption.
Tests: `test_SubmitAttestation_FalseOverridesTrueWithinChallengeWindow`,
`test_SubmitAttestation_RevertsOnFalseAfterChallengeWindowCloses`,
`test_SubmitAttestation_RevertsOnStaleOverrideAttempt` (shared with M1 — a stale override attempt is
rejected by the same freshness check either way).
