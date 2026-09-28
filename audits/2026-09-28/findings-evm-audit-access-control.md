# Access Control Findings: MilestoneEscrow.sol
Checklist: `evm-audit-access-control`. Context used: `contracts/src/MilestoneEscrow.sol`, `contracts/test/MilestoneEscrow.t.sol`, `docs/SPEC.md`, `docs/DAY-ONE-FINDINGS.md`.

Checklist items about owners, pausing, upgrades and roles don't apply to this contract and weren't filed — it deliberately has none of those, by design. The unconfirmed domain issue wasn't re-filed.

## [AC-1] First valid attestation wins: no freshness, ordering or uniqueness rules, so whoever relays chooses the outcome
**Severity**: Medium
**Category**: evm-audit-access-control
**Location**: `submitAttestation()` (MilestoneEscrow.sol:114-134)
**Description**: Anyone can call `submitAttestation`. It accepts any attestation signed by `oracleSigner` that matches `questionHash`, `chainId` and `answerType == "bool"` and has `block.timestamp <= expiresAt`. Nothing else is checked:
- `requestId` is not tied to this escrow.
- `issuedAt`, `fromBlock` and `toBlock` are hashed but never compared with `deadline`. A `false` issued before the deadline is accepted and refunds the payer immediately and permanently.
- There is no rule for choosing between conflicting answers. Whichever is mined first settles the deal: a `true` blocks every later answer (`AlreadyResolvedTrue`), and a `false` ends the deal.

`DAY-ONE-FINDINGS.md` shows that `questionHash` depends only on the quoted request body (the question plus the pinned block range). `oracle.request` is a public paid API (0.5 IMD) with `consumer.verifyingContract` set to this escrow. So anyone can buy extra signed answers for the same escrow. Panel answers are not guaranteed to be the same each time, so either party can keep re-asking until it gets the answer it wants, then relay it or front-run the other side. Letting anyone relay is only safe if each escrow has exactly one signed answer. Nothing on-chain enforces that.

Funds can still only go to `payer` or `payee`. But the result is "the first answer mined", not "the oracle's answer", which breaks the trust model.

**Cross-confirmed independently by evm-audit-signatures ([SIG-2]) and evm-audit-dos ([DOS-5]).**
**Proof of Concept**:
1. The escrow is deployed with `questionHash = Q` and `deadline = D`.
2. Before `D`, the payer calls `oracle.request` with the same body (so the same `Q`, and `consumer = escrow`). The milestone isn't met yet, so the panel answers `false`.
3. The payer calls `submitAttestation(falseAtt, sig)`. Every check passes, because `issuedAt < D` is never checked. The state becomes `Refunded` before the payee's deadline arrives.
4. The reverse also works. After `D`, the resolver gets `false`. The payee keeps re-requesting until a panel returns `true` and relays it first, or front-runs the resolver's `false` relay. `trueAt` is set, the `false` can no longer land, and `release()` pays the payee.

**Recommendation**: Tie the escrow to one oracle answer and to the deal's timeline:
```solidity
// (a) Pin the accepted request (requestId from the paid quote, or a payer+payee co-signed commit)
uint256 public immutable expectedRequestId;
if (m.requestId != expectedRequestId) revert BadRequestId();
// (b) At minimum:
if (m.issuedAt < deadline) revert TooEarly();
if (m.fromBlock != expectedFromBlock || m.toBlock != expectedToBlock) revert BadWindow();
```
Also consider applying `challengeWindow` to `false` answers too, so one early or re-asked `false` can't settle the deal instantly and for good.

## [AC-2] `challengeWindow` has no challenger: nobody can object during the window, so it only delays payout
**Severity**: Medium
**Category**: evm-audit-access-control
**Location**: `release()` (136-147); `submitAttestation()` line 116; `reclaim()` line 150
**Description**: `SPEC.md` says "The contract's challenge window on a true answer gives both sides time to object to a result before money moves." The contract has no way to object. Once `trueAt != 0`:
- `submitAttestation` reverts `AlreadyResolvedTrue`, even for a newer, correctly signed `false` from the same oracle.
- `reclaim` reverts `AlreadyTrue` forever.
- `release()` is callable by anyone once `trueAt + challengeWindow` has passed.

So the window is a delay with nobody able to veto. Users are told they have a dispute right that doesn't exist. After a re-asked `true` (AC-1) or a compromised signer (AC-4), the payer has no recourse on-chain.

**Cross-confirmed independently by evm-audit-general ([GEN-2]) and evm-audit-signatures ([SIG-3]).**
**Proof of Concept**:
1. A wrong `true` is relayed and `trueAt = T`.
2. The payer tries to object. There is no `challenge()` function, and a corrected `false` signed by the oracle reverts `AlreadyResolvedTrue`.
3. At `T + challengeWindow`, anyone calls `release()` and the payee is paid.

The tests only cover the timing boundary (`testFuzz_Release_ChallengeWindowBoundary`) and never test an objection.
**Recommendation**: One option is to let a newer oracle `false` overturn `true` during the window, which needs no admin:
```solidity
uint64 public trueIssuedAt;
if (trueAt != 0) {
    if (block.timestamp >= trueAt + challengeWindow) revert AlreadyResolvedTrue();
    if (m.answer || m.issuedAt <= trueIssuedAt) revert StaleAttestation();
}
```
The other option is to change the SPEC and status page so they describe the window as a delay only.

## [AC-3] Constructor pulls funds from an arbitrary `_payer` based only on an allowance to a not-yet-deployed address: the deployer, not the payer, sets the terms
**Severity**: Medium
**Category**: evm-audit-access-control
**Location**: `constructor` (77-112); line 111 `token.safeTransferFrom(_payer, address(this), _amount)`
**Description**: `_payer` is just an argument. There is no `msg.sender == _payer` check and no payer signature over the terms. The only thing authorizing the pull is an ERC20 allowance the payer gave to a predicted CREATE address before the contract exists. In the tests (`_predictAddress()`), the deployer is not the payer. A CREATE address depends only on the deployer and its nonce, not on the constructor arguments. So the payer's approval is a blank check to whoever controls that nonce, which per the SPEC is the IMD `workflow.open` agent.

That deployer can pick any `payee`, `oracleSigner`, `feeRecipient`, `feeBps` (up to 2%), `deadline`, `grace` and `questionHash`, and the payer's funds are still pulled in the same transaction. Checking the bytecode after deployment is too late. This contradicts the claim that the system "cannot redirect funds". The constructor also accepts self-dealing setups (`oracleSigner == payee`, `oracleSigner == payer`, `payer == payee`).

There is a second failure mode. If some other transaction uses up the deployer's nonce first, the escrow lands at a different address. The payer's allowance then stays open against the deployer's next address, where anyone controlling the deployer can deploy with any terms.

**Cross-confirmed independently by evm-audit-general ([GEN-1]) and evm-audit-erc20 ([ERC20-3]).**
**Proof of Concept**:
1. The payer approves `amount` to `computeCreateAddress(deployer, nonce)`.
2. A compromised or buggy deployer deploys `MilestoneEscrow(payer, attackerPayee, ..., attackerSigner, ...)` at that nonce.
3. The constructor pulls the funds. The attacker signs `true`, waits out the window, calls `release()`, and the funds go to `attackerPayee`.

**Recommendation**: Make the payer's authorization cover the exact terms:
```solidity
// (a)
if (msg.sender != _payer) revert NotPayer();
// (b) Deploy via a CREATE2 factory with salt = keccak256(abi.encode(all constructor args)), so the approved address commits to the terms
// (c) Or verify a payer EIP-712 signature (or Permit2 witness) over the terms hash in the constructor
if (_oracleSigner == _payer || _oracleSigner == _payee || _payer == _payee) revert BadParties();
```

## [AC-4] Single immutable `oracleSigner` with no rotation: key compromise decides any outcome, and key loss or rotation always resolves in the payer's favor
**Severity**: Low
**Category**: evm-audit-access-control
**Location**: `oracleSigner` (lines 48, 106, 124)
**Description**: This is a trust issue that comes with the design, not a code bug. It should be disclosed.
- **Compromise:** whoever holds the key decides every live escrow that uses it. It can't send funds to a third address, but together with the payee (or as the payee, see AC-3) it can take the payer's deposit, and AC-2 leaves the payer no recourse.
- **Rotation or loss:** once IMD rotates or loses the key, no live escrow bound to the old key can ever receive a valid attestation. The only way out is `reclaim()`, which always refunds the payer. A routine key rotation therefore takes the payment away from a payee who met the milestone.

**Proof of Concept**: IMD rotates from key K1 to K2 during a deal. The payee ships on time and a `true` is signed with K2. `submitAttestation` reverts `BadSigner`. After `deadline + grace`, anyone calls `reclaim()` and the payer gets the full amount back.
**Recommendation**: Disclose this in the SPEC and deal UI. If IMD publishes a key-rotation scheme, accept a small immutable set of keys (still no admin), or an ERC-1271 signer contract:
```solidity
address public immutable oracleSignerA; address public immutable oracleSignerB;
if (signer != oracleSignerA && signer != oracleSignerB) revert BadSigner();
```

## [AC-5] `submitAttestation(true)` has no deadline bound, so after `deadline + grace` it races the permissionless `reclaim()`
**Severity**: Low
**Category**: evm-audit-access-control
**Location**: `submitAttestation()` (114-134) vs `reclaim()` (149-157)
**Description**: `submitAttestation` only checks `expiresAt`, never `deadline + grace`. The SPEC example uses `validForSeconds: 604800` (7 days) and fires at the deadline, and the default `grace` is also 7 days. So a `true` issued slightly after the deadline is still valid after `deadline + grace`. In that overlap, both `reclaim()` and a `true` relay are callable by anyone, and transaction ordering decides the winner.

**Cross-confirmed independently by evm-audit-general ([GEN-3]), evm-audit-signatures ([SIG-1]) and evm-audit-dos ([DOS-4]).**
**Proof of Concept**:
1. A `true` is issued at `D+1h`, expiring at `D+1h+7d`. The relay is delayed.
2. At `D+7d+1s`, the payee broadcasts `submitAttestation(true)`.
3. The payer front-runs it with `reclaim()`. The state becomes `Refunded` and the payee's transaction reverts `NotFunded`.

**Recommendation**: Enforce one cutoff on both paths:
```solidity
if (block.timestamp > uint256(deadline) + uint256(grace)) revert TooLate();
```
Alternatively, let an attestation with `issuedAt <= deadline + grace` win even if relayed later, and push `reclaim()` back by a buffer.
