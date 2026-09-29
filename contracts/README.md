# contracts

`MilestoneEscrow.sol`: the on-chain escrow. Payer funds it at construction (a payer-signed
authorization binds the exact terms, not a predicted deploy address); an oracle-signed attestation
(`submitAttestation`) resolves it true or false; `release()`/`reclaim()` settle via pull-payment
(`withdraw()`), sweeping the live token balance rather than a stored nominal amount. 56/56 tests
passing (unit + fuzz), audited — see
[`audits/2026-09-28/AUDIT-REPORT.md`](../audits/2026-09-28/AUDIT-REPORT.md) for the full findings and
fixes (3 High + 3 Medium + 5 Low + 1 Info, all fixed, plus a Slither pass). Live on Base mainnet as a
small self-dealing demo — see the root README's "Proven, with real money" section.

```
forge test
forge build
```

## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
