# MilestoneEscrow — DoS & Griefing Checklist Findings (evm-audit-dos)

Contract: `contracts/src/MilestoneEscrow.sol` (solc 0.8.26, OZ 5.7.0)

Checklist items checked and not filed:
- **Loops:** none exist.
- **ETH / self-destruct:** the contract never touches ETH or reads `address(this).balance`, so force-sent ETH does nothing.
- **Returndata bombs:** OZ 5.7.0 `SafeERC20._safeTransfer` copies at most 32 bytes. It only copies unbounded return data when bubbling up a revert, and that path reverts anyway.
- **Zero-amount transfers:** the fee transfer is guarded by `fee > 0`, and `payeeAmount` is always above 0.
- **Other items:** there are no fixed-gas calls, no try/catch, no pause, no price feed and no `balanceOf` calls.

## [DOS-1] Push-payment to a blocklisted recipient permanently locks escrowed funds with no fallback path
**Severity**: High
**Category**: evm-audit-dos
**Location**: `release()` (:145-146), `reclaim()` (:156), `submitAttestation()` false branch (:132)
**Description**: Every way out pushes tokens straight to a fixed, immutable recipient. The token is intended to be USDC (per `MockUSDC`), and USDC has an issuer blocklist; USDT has one too. If the recipient is blocklisted, `safeTransfer` reverts and there is no other path:
- **Payee or feeRecipient blocklisted after a true attestation:** `release()` always reverts. `reclaim()` reverts `AlreadyTrue` because it checks `trueAt != 0` first (:150). `submitAttestation` is also blocked because `trueAt != 0` (:116). The funds are locked for good.
- **Payer blocklisted before resolution:** the false-attestation transaction reverts at :132, so `state` never changes, and `reclaim()` reverts at :156. The only remaining exit is a true attestation, which the oracle won't sign. The funds are locked for good.

**Cross-confirmed independently by the evm-audit-erc20 pass as [ERC20-2].**
**Proof of Concept**:
1. Deploy with USDC.
2. A true attestation is submitted.
3. Circle blocklists `payee`.
4. `release()` reverts on the USDC transfer.
5. `reclaim()` reverts `AlreadyTrue`.
6. No function can move the tokens.

**Recommendation**: Switch to pull payments. Record amounts owed (`owed[payee]`, `owed[feeRecipient]`, `owed[payer]`) at the state change, and add `withdraw(address to)` so each party pulls its own balance. Letting the caller choose `to` means a blocklisted party can redirect to a clean address it controls. If you keep push payments, use `SafeERC20.trySafeTransfer` and credit `owed` when the transfer fails, so the state change always succeeds.

## [DOS-2] Fee-recipient transfer failure blocks the payee's payout (cross-party coupling)
**Severity**: Medium
**Category**: evm-audit-dos
**Location**: `release()` (:145-146)
**Description**: The fee transfer and the payee transfer happen together in one transaction. If the fee leg reverts, the payee gets nothing. That can happen if `feeRecipient` is blocklisted, or if the token has receive hooks (ERC-777 or ERC-1363 style) and `feeRecipient` is a contract whose hook reverts. The payee's whole payout then depends on a third party it doesn't control. Because `reclaim()` is blocked once `trueAt != 0`, this is a permanent lock, not a delay. It is filed separately from DOS-1 because fixing just the fee leg is cheap.
**Proof of Concept**:
1. `feeRecipient` is blocklisted, or its receive hook reverts.
2. A true attestation is submitted and the challenge window elapses.
3. `release()` reverts on the fee transfer.
4. The payee is locked out for good.

**Recommendation**: Pay the payee first. Then make the fee transfer non-blocking:
```solidity
token.safeTransfer(payee, payeeAmount);
if (fee > 0 && !token.trySafeTransfer(feeRecipient, fee)) unclaimedFee += fee;
```
Alternatively, adopt the full pull-payment pattern from DOS-1.

## [DOS-3] Fee-on-transfer / deflationary tokens make every payout path revert
**Severity**: Medium
**Category**: evm-audit-dos
**Location**: constructor (:111), `release()` (:142-146), `reclaim()` (:156), `submitAttestation()` (:132)
**Description**: The constructor stores `amount = _amount` without checking how much actually arrived. Every exit then transfers exactly `amount`. The contract ends up holding less than `amount` if:
- the token charges a fee on transfer,
- it rebases downward, or
- it is upgradeable and later turns on a fee (USDC is upgradeable).

In any of these cases, every settlement path reverts on insufficient balance. The funds stay frozen until someone donates the shortfall, and nothing in the contract signals the problem.

**Cross-confirmed independently by the evm-audit-general pass as [GEN-4] and evm-audit-erc20 as [ERC20-1].**
**Proof of Concept**:
1. Use a token with a 1% transfer fee and deposit 1000e6. The contract receives 990e6 but stores `amount = 1000e6`.
2. `release()` sends the 10e6 fee, then tries to send 990e6 to the payee while holding only 980e6, and reverts.
3. `reclaim()` tries to send 1000e6 and reverts.

**Recommendation**: In the constructor, measure the balance before and after `safeTransferFrom`. Then either:
- revert when `received != _amount`, or
- compute a local value and assign the immutable `amount` from it.

For the MVP, consider only allowing canonical Sepolia USDC.

## [DOS-4] Refund can be raced and blocked after `deadline + grace` because `submitAttestation` has no deadline cutoff
**Severity**: Medium
**Category**: evm-audit-dos
**Location**: `submitAttestation()` (:114-134) vs `reclaim()` (:149-157)
**Description**: `submitAttestation` only checks `block.timestamp > m.expiresAt`. It never compares against `deadline` or `deadline + grace`, and it never checks `issuedAt`. So after `deadline + grace`, both `reclaim()` and a true `submitAttestation` are valid, and the order transactions land in decides the outcome. Both calls are open to anyone, and a signed attestation is public once the oracle publishes it. That makes a mempool race in both directions:
- The payee can front-run `reclaim()` with a true attestation that hasn't expired, and `reclaim()` then reverts `AlreadyTrue`.
- The payer can front-run a late true submission with `reclaim()`.

The grace period doesn't limit how long the payee can claim. It only sets when the payer can start racing. No test covers a true attestation arriving after `deadline + grace`.

**Cross-confirmed independently by the evm-audit-general pass ([GEN-3]), evm-audit-signatures ([SIG-1]) and evm-audit-access-control ([AC-5]).**
**Proof of Concept**:
1. The oracle signs `true` at T+7d-1h with `expiresAt = T+8d`, and nobody submits it.
2. At T+7d+1 the payer sends `reclaim()`.
3. The payee front-runs with `submitAttestation(true)`.
4. The payer's `reclaim()` reverts `AlreadyTrue`.
5. The reverse ordering works the same way.

**Recommendation**: Add this to `submitAttestation`:
```solidity
if (block.timestamp > uint256(deadline) + uint256(grace)) revert TooLate();
```
Then the two windows never overlap. Optionally also add `if (m.issuedAt > deadline) revert AttestedAfterDeadline();`. Add a test for a late true attestation.

## [DOS-5] Stale-but-unexpired attestations can be replayed out of order; first-submitted wins
**Severity**: Medium
**Category**: evm-audit-dos
**Location**: `submitAttestation()` (:114-134)
**Description**: The contract has no ordering or nonce check: `issuedAt` is signed but never checked, and `requestId` is not tracked. Submission is open to anyone. If the oracle signs more than one answer for the same `questionHash`, any unexpired one can settle the escrow for good. For example, it might sign `false` while the milestone isn't met yet, then `true` after it is. A `false` answer refunds immediately with no challenge window. So the payer, or any griefer, can submit a stale `false` after the milestone has been attested `true`, or front-run the payee's `true` with it. This may overlap with the signature/replay checklist.

**Cross-confirmed independently by the evm-audit-signatures pass as [SIG-2] and evm-audit-access-control as [AC-1].**
**Proof of Concept**:
1. At T1 the oracle signs `false` with `expiresAt = T1+1d`.
2. At T1+2h the oracle signs `true`.
3. The payer submits the T1 `false`, which hasn't expired. The escrow is `Refunded` and the funds go to the payer.
4. The payee's `true` reverts `NotFunded`.

**Recommendation**: Any one of these:
- Only accept `false` at or after the deadline: `if (!m.answer && m.issuedAt < deadline) revert PrematureFalse();`.
- Send `false` answers through the challenge window too, and let an attestation with a later `issuedAt` override an earlier one while the window is open.
- At minimum, confirm with the oracle provider whether it signs multiple answers per question, and document that the first unexpired attestation wins.
