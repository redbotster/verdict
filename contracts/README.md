# contracts

`MilestoneEscrow.sol` is the on-chain escrow. The payer funds it at construction, and a payer-signed
authorization binds the exact terms so a deployer can't swap in different numbers later. An
oracle-signed attestation resolves it true or false, and `release()`/`reclaim()` pay out through
`withdraw()` — pull payments, sweeping whatever the contract actually holds rather than trusting a
stored amount.

56/56 tests passing, audited (3 High + 3 Medium + 5 Low + 1 Info, all fixed) — see
[`audits/2026-09-28/AUDIT-REPORT.md`](../audits/2026-09-28/AUDIT-REPORT.md). Already deployed and
settled for real on Base mainnet, see the root README.

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
