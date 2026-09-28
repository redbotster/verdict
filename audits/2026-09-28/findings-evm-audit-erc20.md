# MilestoneEscrow — evm-audit-erc20 findings

Contract: `contracts/src/MilestoneEscrow.sol` · Checklist: evm-audit-erc20 · Date: 2026-09-28

## [ERC20-1] Settlement pays the nominal `amount`, not the balance actually held, so fee-on-transfer, stETH-style rounding, or negative rebases lock all funds
**Severity**: High
**Category**: evm-audit-erc20
**Location**: `constructor` (MilestoneEscrow.sol:111), `submitAttestation()` (:132), `release()` (:142-146), `reclaim()` (:156)
**Description**: The constructor calls `token.safeTransferFrom(_payer, address(this), _amount)` and stores `_amount` as the immutable `amount` without checking how much actually arrived. Every exit path then sends exactly `amount`:
- `release()` sends `fee + payeeAmount == amount`.
- The false-answer branch and `reclaim()` each send `amount` to the payer.

If the contract holds even 1 wei less than `amount`, all three exit paths revert. There is no admin and no sweep function, so the funds stay locked unless someone donates the shortfall. Three kinds of token cause this:
- **Fee-on-transfer tokens** (STA, PAXG, or a token whose fee switch is on at deposit time).
- **Share-based tokens like stETH.** `transferFrom` often delivers 1-2 wei less than requested because of rounding.
- **Negative rebases or slashing** (for example AMPL) while funds are held.

The opposite case is also a problem. A positive rebase (stETH, aTokens) or a stray transfer or airdrop leaves a surplus above `amount` in the contract forever, because nothing ever pays out more than `amount`. The tests only use a plain OZ ERC20 (`MockUSDC`), so none of this is covered.

**Cross-confirmed independently by the evm-audit-general pass as [GEN-4] (rated Medium there).**
**Proof of Concept**:
1. Deploy with stETH (or a token with a 1% transfer fee) and `amount = 1000e18`.
2. The escrow's balance ends up at `1000e18 - 1` (stETH) or `990e18` (1% fee).
3. The oracle attests true. After the challenge window, `release()` sends the fee, then `safeTransfer(payee, 980e18)` reverts, so the whole call reverts.
4. `reclaim()` reverts with `AlreadyTrue`, so the funds are permanently locked. On the no-true path, `reclaim()` and the false-answer refund revert the same way.
**Recommendation**: Check the balance before and after the constructor's `transferFrom`. Either revert with `UnsupportedToken` if `received != _amount`, or store `received` as the escrowed amount. At settlement, pay out `token.balanceOf(address(this))`: the fee is `bal * feeBps / BPS_DENOMINATOR`, and refunds send the whole balance. At minimum, restrict tokens to plain, fee-free, non-rebasing ones in the deployment pipeline.

## [ERC20-2] Push-only payouts: a blocklisted or reverting payee, fee recipient, or payer permanently locks the escrow
**Severity**: High
**Category**: evm-audit-erc20
**Location**: `release()` (:145-146), `submitAttestation()` false branch (:132), `reclaim()` (:150, :156)
**Description**: USDC, including Circle's test USDC, has a blocklist and can be paused. Every payout goes straight to a fixed recipient, with no alternate destination and no pull option.
- **Payee or fee recipient blocklisted:** `release()` reverts at line 145 or 146. Once `trueAt` is set, line 150 (`AlreadyTrue`) permanently disables `reclaim()`, so the full amount is locked forever.
- **Fee recipient can block the payee:** the fee transfer and the payee transfer are coupled. If the third-party `feeRecipient` is blocklisted, or is a contract or ERC777 hook that reverts, the payee's 98% or more is blocked too.
- **Payer blocklisted:** a false attestation can never be applied, because line 132 reverts atomically. `reclaim()` also reverts at line 156. The funds stay in `Funded` state indefinitely.
- **Escrow address blocklisted:** all exits revert. This is inherent to the token; document it.

A token pause only delays settlement. The blocklist and hook cases are permanent.
**Proof of Concept**:
1. Deploy with USDC and `feeBps = 100`.
2. The oracle attests true.
3. Circle blocklists `feeRecipient`.
4. `release()` always reverts on the fee transfer, `reclaim()` reverts with `AlreadyTrue`, and `submitAttestation` reverts with `AlreadyResolvedTrue`. The full amount is locked with no recovery.
**Recommendation**: Switch to a pull pattern. Settlement credits `owed[feeRecipient]`, `owed[payee]` or `owed[payer]`, and each party calls `withdraw(address to)`, which zeroes their balance and then does `safeTransfer(to, amt)`. A smaller change would be a payee-only `release(address to)` and a payer-only `reclaim(address to)`, plus wrapping the fee transfer so that a failure credits `owed[feeRecipient]` instead of reverting.

## [ERC20-3] Constructor pulls from an arbitrary `_payer` using an approval made to a predicted address, so any deployment that lands at that address can spend the payer's allowance
**Severity**: Medium (High if deployed through a shared or permissionless deployer)
**Category**: evm-audit-erc20
**Location**: `constructor` (:78, :111)
**Description**: Funding uses `safeTransferFrom(_payer, ...)`, where `_payer` is a constructor argument rather than `msg.sender`. The payer approves the predicted CREATE address (the tests do this with `vm.computeCreateAddress`). The only protection for that allowance is that nobody else can deploy different arguments at that address.

That only holds when the payer deploys from their own EOA. `docs/SPEC.md` says the system deploys the contract (IMD `workflow.open`), so a third-party wallet does the deploying:
- **The deployer's nonce moves first** (another customer's workflow, a retry, or a failed transaction that used the nonce). The payer's approval now sits on the address of some future deployment. Any later escrow that names this payer then pulls the allowance, with whatever payee and oracle it was given.
- **The deployer can be triggered by anyone** (a public factory or a shared workflow wallet). An attacker can race to that nonce with `_payer = victim`, `payee` and `oracleSigner` set to their own addresses, and `challengeWindow = 0`. They then sign their own true attestation and call `release()`.
- **Over-approval:** a payer who approves more than `amount` leaves the extra allowance on that address.

**Cross-confirmed independently by the evm-audit-general pass as [GEN-1].**
**Proof of Concept**:
1. Shared deployer D is at nonce N.
2. The payer approves `computeCreateAddress(D, N)` for 1000 USDC.
3. Before the legitimate deploy, D deploys an escrow at nonce N with `_payer = victim` and attacker-controlled payee and oracle. Its constructor pulls the 1000 USDC.
4. The attacker signs `answer = true` and calls `release()`.
**Recommendation**: Use one of these, and have payers approve exactly `amount`:
- Require `msg.sender == _payer` in the constructor.
- Deploy through a factory that does `transferFrom(msg.sender, ...)`.
- Deploy with CREATE2 and a salt of `keccak256(abi.encode(allParams))`, so the approved address can only ever hold these exact terms.
- Use a Permit2 witness transfer that commits to all the deal terms.

## [ERC20-4] No sanity checks that recipients are not `address(token)` or `address(this)`
**Severity**: Low
**Category**: evm-audit-erc20
**Location**: `constructor` (:92-95)
**Description**: The constructor only rejects `address(0)`. If the payee, payer or fee recipient equals `address(token)`, the result depends on the token:
- LUSD-style tokens revert on transfers to their own address, which permanently blocks that path (compounds ERC20-2).
- OZ-style tokens accept the transfer, which burns the funds at the token address.
- If a recipient is the escrow's own predicted address, settlement "succeeds" but the funds never leave.

These are misconfigurations, but the deployment pipeline builds its arguments from a plain-English deal description, so a cheap on-chain guard is worth having.
**Proof of Concept**: Deploy with `_payee = address(_token)` using MockUSDC. After a true attestation, `release()` sends 98% of `amount` to the token contract, where it cannot be recovered.
**Recommendation**: Revert with `BadRecipient` if any of payee, payer or fee recipient equals `address(_token)` or `address(this)`. Optionally also revert if `_payee == _payer`.

### Checked and clean
- **ERC777/ERC677 reentrancy:** state is set before every transfer, so re-entering reverts with `NotFunded` or `AlreadyTrue`. A hook can still block settlement by reverting; that is covered in ERC20-2.
- **Tokens that don't return a bool (USDT):** all transfers go through OZ SafeERC20, which also checks that the token address has code.
- **Zero-amount transfers:** the fee transfer is guarded by `fee > 0`, and the payee and refund amounts are always greater than 0.
- **Decimals, totalSupply, permit and metadata:** not used by the contract.
