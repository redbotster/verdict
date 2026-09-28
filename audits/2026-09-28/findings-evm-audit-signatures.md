# Findings — evm-audit-signatures

Contract: `contracts/src/MilestoneEscrow.sol` (OpenZeppelin 5.7.0 `EIP712` / `ECDSA`, solc 0.8.26)

## Verified clean (no finding)
- **Cross-chain replay**: The domain includes `block.chainid`. OZ `_domainSeparatorV4()` recomputes it when the chain ID changes (EIP712.sol:93), so it stays correct after a fork. `m.chainId == block.chainid` is also checked (L117); this is redundant but harmless.
- **Cross-instance replay**: The domain includes `verifyingContract = address(this)`. `test_SignatureForDifferentInstanceDoesNotVerify` confirms a signature for one escrow fails on another.
- **Replay / nonce**: There is no nonce, but the state machine allows only one settlement per escrow. `trueAt != 0` (L116) and `state != Funded` (L115) block any resubmission. Signatures are never stored or used as IDs.
- **Malleability**: OZ 5.7.0 `ECDSA.recover` rejects high-`s` values and anything but 65-byte signatures, and there is no used-signature mapping to bypass anyway.
- **ecrecover returning address(0)**: `recover` reverts on an invalid signature, and the constructor rejects a zero `oracleSigner`.
- **Struct hash covers all fields**: The typehash at L35 lists all 11 fields in order. Every field is encoded with `abi.encode`. Strings are hashed with `keccak256`, and `bool` and `uint64` are padded to 32 bytes, as EIP-712 requires. There is no `encodePacked` collision risk, and the test's independent rebuild of the hash matches.
- **Expiration**: `expiresAt` is signed and enforced at L120.
- **Permit / ERC-2771 / ERC-1271 / relayer items**: None of these patterns are present.

---

## [SIG-1] Signed time-scope fields (`issuedAt`, `fromBlock`, `toBlock`) are never checked against the escrow `deadline`, so a premature `false` attestation causes an immediate, irreversible refund
**Severity**: Medium
**Category**: evm-audit-signatures
**Location**: `submitAttestation()` — MilestoneEscrow.sol:114-134; signed fields at L27-L31
**Description**: The oracle signs `issuedAt`, `fromBlock` and `toBlock`, which describe when the claim was evaluated, but the contract validates none of them. The only time check is `block.timestamp <= m.expiresAt`. That limits how long the signature can be used, not which period the answer covers. `submitAttestation` never reads `deadline` (L45).
- **`false` path (main issue)**: A validly signed `false` for a window ending before the deadline is accepted at L129-132. The escrow moves to `Refunded` and the payer is paid on the spot, with no challenge window and no way to reverse it. "Not done as of block N" is not proof the milestone failed by the deadline.
- **`true` path (secondary)**: A `true` issued long after the deadline is accepted whenever `reclaim()` hasn't run yet. After `deadline + grace`, the outcome depends on whether the payer's `reclaim()` or the payee's `submitAttestation(true)` lands first.
- `issuedAt <= block.timestamp` and `issuedAt <= expiresAt` are also never checked, so an attestation dated in the future is accepted.

The only on-chain link between an attestation and this escrow is `questionHash` plus the domain. This may be intended if `questionHash` encodes the deadline and IMD only answers after it passes. Nothing in the code enforces that assumption, and nothing in the code or tests documents it.
**Proof of Concept**:
1. The escrow is deployed with `deadline = T0 + 10 days`.
2. On day 2, IMD evaluates the question up to day 2 and signs `answer=false`, `issuedAt=day2`, `expiresAt=day2+1d`.
3. The payer, or anyone who sees the payload, calls `submitAttestation(m, sig)` on day 2.
4. All checks at L115-L124 pass. `state = Refunded`, and the full `amount` goes to the payer.
5. On day 9 the payee delivers the milestone, but the escrow is already closed and the payee has no recourse.

Mirror case: on day 25, after `deadline + grace` (day 17), the payer hasn't called `reclaim()` yet. The payee submits a `true` evaluated on day 25, which blocks `reclaim()` via `AlreadyTrue` even though the deadline was missed.
**Recommendation**:
```solidity
if (m.issuedAt > block.timestamp || m.issuedAt > m.expiresAt) revert BadIssuedAt();
if (m.answer) {
    // optional: if (m.issuedAt > uint256(deadline) + uint256(grace)) revert LateAttestation();
    trueAt = block.timestamp;
    emit TrueAttested(m.requestId, trueAt);
} else {
    if (m.issuedAt < deadline) revert PrematureFalse(); // a negative answer only counts after the deadline
    state = State.Refunded;
    ...
}
```
A stronger option is to store a deadline block, or the question's block window, at construction. Then require `m.toBlock >= deadlineBlock` for `false`, and `fromBlock`/`toBlock` inside the milestone window for `true`. If the design really relies on `questionHash` encoding the deadline, say so in the NatSpec and add a test for it.

---

## [SIG-2] When several valid attestations exist for one question, the first one submitted wins, and nothing orders them by `requestId` or `issuedAt`
**Severity**: Low
**Category**: evm-audit-signatures
**Location**: `submitAttestation()` — MilestoneEscrow.sol:114-134
**Description**: `requestId` and `issuedAt` are signed but never used to choose between competing attestations. If the oracle has issued more than one unexpired attestation for this escrow, the first one submitted decides the outcome. That can happen through re-requests, re-evaluation, or a different `panelJobId`. The race also favors `false`: a `false` settles immediately, while a `true` only sets `trueAt`. After a `true`, a later `false` reverts at L116. Submission is open to anyone (no `msg.sender` binding), so whoever submits first can pick a stale signed result, as long as it hasn't expired.
**Proof of Concept**:
1. Request #1 returns `false` (`issuedAt t1`, expires `t1+1d`).
2. Request #2 returns `true` (`issuedAt t2 > t1`).
3. The payer submits #1 before `t1+1d`. The escrow refunds, and the newer `true` can never be applied.
4. Reverse case: a stale `true` submitted first makes the newer `false` revert with `AlreadyResolvedTrue`.
**Recommendation**: Either enforce one answer per escrow (for example, bind the expected `requestId` at construction), or keep the newest answer:
```solidity
uint64 public lastIssuedAt;
if (m.issuedAt <= lastIssuedAt) revert StaleAttestation();
lastIssuedAt = m.issuedAt;
```
With the second option, `false` should also go through the challenge window so a newer answer can override it. At a minimum, document that IMD must never have more than one unexpired attestation per escrow, and keep `expiresAt` short.

---

## [SIG-3] Oracle key compromise or a mis-signed attestation cannot be contested: the signer is immutable, cannot be revoked, and the "challenge window" has no challenge path
**Severity**: Low
**Category**: evm-audit-signatures
**Location**: `oracleSigner` (L48); `submitAttestation()` L126-128; `release()` L136-147
**Description**: A valid signature is the only settlement check. `oracleSigner` is immutable, with no admin, no revocation and no dispute function. `release()` waits `challengeWindow` after `trueAt`, but nothing can be called during that window: `reclaim()` reverts `AlreadyTrue` and `submitAttestation` reverts `AlreadyResolvedTrue`. The window therefore gives no protection against a forged, leaked or wrong `true`, and the `false` path has no window at all. **This is a real gap against the product spec**, which states: "The contract's challenge window on a true answer gives both sides time to object to a result before money moves" — as built, the window delays payout but provides no mechanism to object.
**Proof of Concept**:
1. The oracle key leaks, or IMD signs `true` by mistake.
2. The `true` is submitted and `trueAt` is set.
3. The payer has nothing to call during `challengeWindow`. Once it ends, anyone calls `release()` and the funds go to the payee.
**Recommendation**: Add a real `challenge()` function callable while `block.timestamp < trueAt + challengeWindow` that moves the escrow to a `Disputed` state with a defined resolution path. Alternatively, accept a retraction from the same oracle with a higher `issuedAt` during the window. If the oracle is meant to be final, document that `challengeWindow` is only a delay and that a key compromise means losing the funds in every live escrow.
