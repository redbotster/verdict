# Findings: evm-audit-general

Contract: `contracts/src/MilestoneEscrow.sol` (Solidity 0.8.26, via_ir, cancun)
Checklist: `/tmp/evm-audit/evm-audit-general.md`
Context used: `contracts/test/MilestoneEscrow.t.sol`, `docs/SPEC.md`

Checklist items that do not apply to this contract (no low-level calls, delegatecall, msg.value, loops, merkle proofs, pause, upgradeability, unchecked blocks, downcasts, storage pointers, struct deletes, or on-chain `abi.encodePacked`) are omitted. All three state-changing functions follow checks-effects-interactions, so ERC777-style hook reentrancy has nothing to exploit. EIP-712 dynamic fields are hashed correctly with `abi.encode`. The known "unconfirmed domain/type layout" caveat is out of scope.

---

## [GEN-1] Constructor-pull funding lets the deployer choose the deal terms that the payer's allowance funds
**Severity**: Medium
**Category**: evm-audit-general
**Location**: `constructor` (MilestoneEscrow.sol:77-112), `token.safeTransferFrom(_payer, address(this), _amount)` at line 111
**Description**: The constructor funds the escrow by pulling from `_payer`. So the payer must `approve` a precomputed CREATE address (`deployer + nonce`) before the contract exists; the tests do this with `vm.computeCreateAddress`. That allowance is tied only to an address, not to the deal terms. Whoever controls the deployer's nonce sets every constructor argument: `_payee`, `_oracleSigner`, `_feeRecipient`, `_feeBps`, `_deadline`, `_grace`, `_challengeWindow`, `_questionHash` and the domain strings. The constructor never checks `msg.sender == _payer`. SPEC.md says "the system deploys the contract" (workflow.open) and that "The agent only relays a signed attestation ... it cannot redirect funds". Pulling funds in the constructor breaks that promise at deploy time: the deploying agent can send the funds elsewhere before any attestation exists. This is the checklist's "precomputed CREATE address / reorg" hazard, showing up as a trust-model problem.
**Proof of Concept**:
1. The payer agrees to terms (payee = Alice, oracleSigner = IMD) and approves the predicted address `P = create(deployer, n)` for `amount`.
2. The deployer (compromised, buggy or malicious) deploys `MilestoneEscrow` at nonce `n` with `_payee = Mallory, _oracleSigner = Mallory`. The constructor pulls the payer's funds.
3. Mallory signs a `true` Attestation for `P`, waits out `challengeWindow` (which can be 0), and calls `release()`.
Variant: the intended deployment at nonce `n` fails or is replaced (dropped tx, nonce reuse, reorg). The payer's allowance to `P` stays live. A later escrow deployed at `P` that names the same payer then uses it.
**Recommendation**: Tie the funds to the terms, or have the payer fund the escrow directly:
- Require the payer to be the deployer: `if (msg.sender != _payer) revert NotPayer();`, or
- Deploy through a factory with CREATE2 and `salt = keccak256(abi.encode(all constructor args))`, with the factory pulling from `msg.sender` (the payer) in the same call:
```solidity
function create(Terms calldata t) external returns (MilestoneEscrow e) {
    require(msg.sender == t.payer);
    e = new MilestoneEscrow{salt: keccak256(abi.encode(t))}(t /* no pull in ctor */);
    t.token.safeTransferFrom(msg.sender, address(e), t.amount);
}
```
- Or accept an EIP-2612/Permit2 signature from the payer over a struct containing every term, and verify it in the constructor.

---

## [GEN-2] "Challenge window" has no challenge mechanism; nothing can object to a true answer
**Severity**: Medium
**Category**: evm-audit-general
**Location**: `submitAttestation()` lines 115-128, `release()` lines 136-147
**Description**: The documentation and the code disagree. SPEC.md:53 says "The contract's challenge window on a true answer gives both sides time to object to a result before money moves". SPEC.md:263 lists the 24h challenge window as the mitigation for "One attester signer key is a single trust point". But the contract has no function to object, dispute, cancel or pause during the window. Once `trueAt != 0`:
- `submitAttestation` reverts with `AlreadyResolvedTrue` (line 116), so even a later oracle-signed `false` cannot land.
- `reclaim` reverts with `AlreadyTrue` (line 150).
- `release` becomes callable by anyone at `trueAt + challengeWindow`.
The window is only a time delay. Observers can notice a bad result during it, but there is no on-chain action they can take. The risk register counts on it as the control against a compromised signer key, and it gives no protection there. A compromised signer means loss of funds once the delay ends.

**Cross-confirmed independently by the evm-audit-signatures pass as [SIG-3].**
**Proof of Concept**: The oracle signer key is compromised, or the panel answers wrongly. The attacker submits `true` and calls `release()` after `challengeWindow`. The payer sees the result during the window but has nothing to call, and the funds go to the payee.
**Recommendation**: Either add a real challenge path or stop calling it one. Minimal version:
```solidity
function challenge() external {
    if (msg.sender != payer) revert NotPayer();
    if (trueAt == 0 || block.timestamp >= trueAt + challengeWindow) revert NotInWindow();
    if (state != State.Funded) revert NotFunded();
    state = State.Disputed; // release() requires Funded; add a resolution path (e.g. refund after deadline+grace unless both parties co-sign release)
}
```
If the MVP is not meant to have one, change SPEC.md:53 and :263 to call it a "settlement delay" and drop it as a mitigation for signer compromise.

---

## [GEN-3] Attestation is not bound to the deadline: false refunds before the deadline, true pays after deadline+grace
**Severity**: Medium
**Category**: evm-audit-general
**Location**: `submitAttestation()` lines 114-134; unchecked fields `m.issuedAt`, `m.fromBlock`, `m.toBlock`
**Description**: `submitAttestation` checks chain, question, answer type, expiry and signer. It never compares any time field against `deadline` or `deadline + grace`. The fields `issuedAt`, `fromBlock` and `toBlock` are signed but never checked. That causes two departures from the spec and one ordering race. The race matches the checklist's reveal-gap steering: the outcome depends on which transaction is mined first, not on state fixed when the answer was produced.
1. **Early false**: SPEC.md:13 says "refunds the payer on false *after a deadline*", and SPEC.md:51 says the resolver acts "at the deadline, not before". The contract does not enforce this. A valid `false` attestation for this `questionHash`, issued any time before the deadline, immediately and permanently refunds the payer (`state = Refunded`), even if the payee would have finished in time. Only off-chain behaviour prevents this: the resolver's schedule and the oracle's "missing evidence is not false" rule.
2. **Late true**: a `true` attestation is still accepted after `deadline + grace`, as long as nobody has called `reclaim()` yet.
3. **Race after deadline+grace**: once `deadline + grace` has passed, the outcome depends on whether `reclaim()` or `submitAttestation(true)` is mined first. Both are permissionless, so either party, or an MEV searcher acting for one, can front-run the other.

**Cross-confirmed independently by the evm-audit-signatures pass as [SIG-1].**
**Proof of Concept**:
- (1) Before the deadline, the payer (or anyone) obtains or relays a `false` attestation for this escrow's `questionHash` with an unexpired `expiresAt`, for example from an early or premature panel run, and calls `submitAttestation`. The funds go back to the payer before the deadline.
- (3) At `deadline + grace + 1`, the payer broadcasts `reclaim()`. The payee sees it in the mempool and front-runs it with a held, unexpired `true` attestation, and the payee gets paid instead. The reverse ordering works too.
**Recommendation**: Make the attestation's time range part of what the contract checks. For example:
```solidity
if (!m.answer && block.timestamp < deadline) revert TooEarly();          // false only counts once the milestone period has ended
if (block.timestamp > uint256(deadline) + uint256(grace)) revert PastGrace(); // no true after the reclaim window opens
// and, once IMD semantics are confirmed, check the evidence window covers the deal period (issuedAt / toBlock vs deadline)
```
At minimum, only accept `false` once `block.timestamp >= deadline`, and add a cutoff for `true`, so the outcome does not depend on transaction ordering.

---

## [GEN-4] Stored `amount` vs actual balance: fee-on-transfer / rebasing tokens break settlement
**Severity**: Medium
**Category**: evm-audit-general
**Location**: constructor line 111; `submitAttestation()` line 132; `release()` lines 142-146; `reclaim()` line 156
**Description**: Every payout path sends exactly the immutable `amount` (release sends `fee + (amount - fee) == amount`) and never reads `token.balanceOf(address(this))`. The constructor comment (lines 75-76) says the contract "is always fully funded from the moment it exists". That is false for any token where the escrow receives less than `amount`: fee-on-transfer tokens, negative-rebasing tokens, or a USDC-style token whose fee switch is later turned on. With such a token, every settlement path fails:
- `release()`: the fee transfer succeeds, then `safeTransfer(payee, amount - fee)` reverts for lack of balance, so the whole transaction reverts.
- `reclaim()` and the false path of `submitAttestation()`: `safeTransfer(payer, amount)` reverts.
The funds stay stuck until someone donates the shortfall. On the false path, the signed attestation may expire in the meantime, leaving only `reclaim()` after `deadline+grace`. In the opposite case, a positive rebase or a donation leaves surplus stranded (GEN-6). `token` is an arbitrary, unrestricted constructor argument.

**Cross-confirmed independently by the evm-audit-erc20 pass as [ERC20-1] (rated High there).**
**Proof of Concept**: Deploy with a token that takes a 1% fee on transfer. The constructor pulls 1000 and the escrow receives 990. After a true attestation and the window, `release()` tries to send 10 + 990 = 1000 from a 990 balance and reverts. `reclaim()` would revert the same way. The funds are locked until a third party sends 10 tokens.
**Recommendation**: Check the received balance in the constructor and reject tokens that deliver less:
```solidity
uint256 before = _token.balanceOf(address(this));
_token.safeTransferFrom(_payer, address(this), _amount);
if (_token.balanceOf(address(this)) - before != _amount) revert UnsupportedToken();
```
Also document that only standard, non-rebasing ERC20s are supported, or allow-list USDC-test. Optionally, pay out the live balance at settlement.

---

## [GEN-5] Constructor accepts nonsensical timing parameters
**Severity**: Low
**Category**: evm-audit-general
**Location**: `constructor` lines 92-97
**Description**: The constructor checks addresses, `amount` and `feeBps`, but not the timing values. `_deadline` can be in the past, so with `_grace == 0`, `reclaim()` is callable from the next block and the payee gets no time. `_challengeWindow == 0` is allowed, so `release()` can run in the same block as the true attestation. There are no upper bounds either. A `_deadline` or `_grace` near `type(uint64).max` does not overflow, because the sum is computed in uint256, but it effectively disables `reclaim()`. If the oracle never answers, the payer's funds stay locked indefinitely. These are deployer mistakes, not attacks. They matter more because of GEN-1 (the deployer chooses the terms), and with no admin there is no way to fix them afterwards.
**Proof of Concept**: Deploy with `_deadline = block.timestamp - 1` and `_grace = 0`. In the next block, anyone calls `reclaim()` and the deal ends.
**Recommendation**:
```solidity
if (_deadline <= block.timestamp) revert BadDeadline();
if (_grace < MIN_GRACE || _grace > MAX_GRACE) revert BadGrace();
if (_challengeWindow > MAX_CHALLENGE_WINDOW) revert BadWindow();
```

---

## [GEN-6] Tokens sent directly to the escrow, or left over, are permanently stranded
**Severity**: Low
**Category**: evm-audit-general
**Location**: contract-wide (no sweep); `release()` / `reclaim()` pay the fixed `amount`
**Description**: Accounting uses only the immutable `amount`. Any extra balance of `token` has no way out: a mistaken direct transfer, a donation made to unbrick GEN-4, a positive rebase, or airdrops of other tokens. Because there is no owner or admin by design, it cannot be recovered. There is no direct risk to the escrowed `amount`.
**Proof of Concept**: A user mistakenly sends 50 USDC-test to the escrow. After `release()` pays out 1000, the remaining 50 is stuck, and every function reverts with `NotFunded` or `AlreadyTrue`.
**Recommendation**: Make the final settlement transfer send the full remaining `token` balance, so the payee (on release) or the payer (on refund) receives any surplus:
```solidity
uint256 bal = token.balanceOf(address(this));
uint256 fee = (amount * feeBps) / BPS_DENOMINATOR;
token.safeTransfer(feeRecipient, fee);
token.safeTransfer(payee, bal - fee);
```
Or add a permissionless post-settlement `sweep(IERC20 other)` that sends leftovers to the payer.
