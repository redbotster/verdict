# Findings: evm-audit-precision-math

Contract: `contracts/src/MilestoneEscrow.sol`
Checklist: `/tmp/evm-audit/evm-audit-precision-math.md`
Token context: `MockUSDC` (test mock) uses 6 decimals. The contract makes no decimal assumptions.

## Checklist items checked and clean (not filed)

- **Division before multiplication**: `release()` computes `(amount * feeBps) / BPS_DENOMINATOR`, multiplying before dividing. There are no chained divisions.
- **Dust or leftover balance**: `payeeAmount = amount - fee`, so `fee + payeeAmount == amount` exactly. No wei is left in the contract (the fuzz test `testFuzz_Release_FeeNeverExceedsCap` also checks this). The subtraction cannot underflow because `feeBps <= 200`, so `fee <= amount`.
- **Downcasts**: the contract has no explicit downcasts. The `uint64` fields `issuedAt` and `expiresAt` come from calldata, where the ABI decoder range-checks them. `uint16 feeBps` is promoted to `uint256` in the fee product.
- **Time arithmetic**: `trueAt + challengeWindow` is `uint256 + uint64`, done in `uint256`. `reclaim()` casts both `uint64` values to `uint256` before adding them. Neither can overflow, and there is no `unchecked` block anywhere.
- **Boundary operators**: the comparisons are consistent. `release()` is allowed at exactly `trueAt + challengeWindow`. `reclaim()` is allowed strictly after `deadline + grace`. An attestation is valid up to and including `expiresAt`. The tests cover each of these boundaries.
- **Decimal handling**: the fee is a pure bps ratio of `amount` and has no price or oracle scaling, so it works the same for 6-decimal and 18-decimal tokens.

---

## [MATH-1] Checked overflow in `amount * feeBps` can make `release()` revert forever, locking funds after a true attestation
**Severity**: Low
**Category**: evm-audit-precision-math
**Location**: `release()`, MilestoneEscrow.sol:142
**Description**: `uint256 fee = (amount * feeBps) / BPS_DENOMINATOR;` runs in checked arithmetic. If `amount > type(uint256).max / feeBps` (about 5.79e74 when `feeBps == 200`), the multiplication overflows and reverts. The constructor only checks `amount != 0`, so this value is not rejected at deployment. This is a latent problem because of how the state machine works. Once a true attestation sets `trueAt != 0`:
- `release()` is the only way to pay out, and it would always revert.
- `reclaim()` reverts with `AlreadyTrue`.
- `submitAttestation()` reverts with `AlreadyResolvedTrue`.

The whole `amount` would stay locked in the contract with no exit. This cannot happen with USDC or with any token whose supply is realistic. It needs a token with a supply of about 1e74 or more, which only a custom or adversarial ERC20 would have. Because of that, the severity is Low (latent bug) rather than High.
**Proof of Concept**:
1. Deploy an ERC20 with `decimals = 18`, mint `2**255` to the payer, and approve the predicted escrow address.
2. Deploy `MilestoneEscrow` with `_amount = 2**255` and `_feeBps = 2`. The constructor's `safeTransferFrom` succeeds.
3. The oracle signs `answer = true`, and `submitAttestation` sets `trueAt`.
4. After `challengeWindow`, `release()` computes `2**255 * 2`, which overflows and reverts with a 0x11 panic. It does this on every call.
5. `reclaim()` reverts with `AlreadyTrue`. The funds are locked permanently.
**Recommendation**: Either use a multiplication that cannot overflow in the intermediate step, or reject such amounts at construction:
```solidity
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
// release()
uint256 fee = Math.mulDiv(amount, feeBps, BPS_DENOMINATOR);
```
or, in the constructor:
```solidity
if (_amount > type(uint256).max / BPS_DENOMINATOR) revert AmountTooLarge();
```

## [MATH-2] Fee rounds down, and is zero when `amount * feeBps < 10_000`
**Severity**: Info
**Category**: evm-audit-precision-math
**Location**: `release()`, MilestoneEscrow.sol:142
**Description**: Integer division truncates the fee toward zero, so any remainder goes to the payee instead of `feeRecipient`. When `amount * feeBps < 10_000`, the fee is exactly 0 and the `if (fee > 0)` branch skips the transfer. With a 6-decimal token at the 200 bps cap, this happens for `amount < 50` base units (under $0.00005). At 1 bps, it happens for `amount < 10_000` base units ($0.01). In every case, at most `10_000 / feeBps - 1` base units of fee are lost per escrow. Each escrow is its own deployment with its own gas cost, so splitting a payment into many tiny escrows to avoid the fee costs much more than it saves. The contract doesn't state which way the fee should round. Rounding down (in favor of the payee) is a reasonable choice for an escrow, but it should be a deliberate decision.
**Proof of Concept**: Deploy with `_amount = 49`, `_feeBps = 200`, and a 6-decimal token. After a true attestation and the challenge window, `release()` computes `fee = 49 * 200 / 10000 = 0`, so `feeRecipient` receives 0 and `payee` receives 49.
**Recommendation**: If rounding down is intended, add a NatSpec note that says so. If the protocol should keep the rounding remainder, round up:
```solidity
uint256 fee = Math.mulDiv(amount, feeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
```
This still satisfies `fee <= amount` because `feeBps <= 200 < 10_000`. Optionally, enforce a minimum `amount` in the constructor.
