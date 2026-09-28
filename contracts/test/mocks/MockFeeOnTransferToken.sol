// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockFeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 _feeBps) ERC20("Fee On Transfer Token", "FOT") {
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // Only transferFrom charges a fee — the constructor's initial pull is the only path this mock needs to exercise.
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = (amount * feeBps) / 10_000;
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount - fee);
        if (fee > 0) _burn(from, fee);
        return true;
    }
}
