// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// Regression test, not a fixture-based unit test: pins the contract's attestation hashing/domain
// logic against one real, captured IMD attestation (message + real signature + real reported
// signer), so any future accidental drift in ATTESTATION_TYPEHASH, the Attestation struct's field
// order/types, or the domain name breaks this test immediately, rather than silently reintroducing
// the exact bug found and fixed in docs/DAY-ONE-FINDINGS.md §25 (the contract's prior scheme never
// matched IMD's real signature at all).
contract RealAttestationCheckTest is Test {
    function test_RealCapturedAttestationStructHashMatchesContractLogic() public {
        // Real message captured 2026-09-29 from a real paid oracle.request, via IMD's dedicated
        // GET /oracle/requests/:id/attestation endpoint. See docs/DAY-ONE-FINDINGS.md §25.
        MilestoneEscrow.Attestation memory m = MilestoneEscrow.Attestation({
            requestId: 0x52523387b5be49339932634f90e2dc3000000000000000000000000000000000,
            chainId: 1,
            questionHash: 0xa34745703a3601fbca040a13ea8926f8f8e0752f58ce955f3b43e3651fa18a91,
            answerType: 0,
            answer: hex"0000000000000000000000000000000000000000000000000000000000000001",
            figure: 0,
            fromBlock: 26078576,
            toBlock: 26086048,
            blockHash: 0x75592d9457551014314a3fe70ea934406dc680bd9e26d6d30361812e1ab93210,
            panelJobId: 0xd57e7d7838d54b6193e97192ff7909dd00000000000000000000000000000000,
            issuedAt: 1790720297,
            expiresAt: 1791325097
        });

        // Deploy any real escrow instance just to call its pure hashAttestation() — the struct hash
        // doesn't depend on the contract's address or domain at all.
        MockUSDC token = new MockUSDC();
        uint256 payerPk = 0xB0B;
        address payer = vm.addr(payerPk);
        address payee = makeAddr("payee");
        token.mint(payer, 1000e6);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(payer);
        token.approve(predicted, 1000e6);

        bytes32 TERMS_TYPEHASH = keccak256(
            "EscrowTerms(address payer,address payee,address token,uint256 amount,uint64 deadline,uint64 grace,bytes32 questionHash,address oracleSigner,address feeRecipient,uint16 feeBps,uint64 challengeWindow)"
        );
        bytes32 termsHash = keccak256(
            abi.encode(
                TERMS_TYPEHASH, payer, payee, address(token), uint256(1000e6), uint64(block.timestamp + 1 days),
                uint64(0), m.questionHash, address(0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982), payee, uint16(0), uint64(0)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, MessageHashUtils.toEthSignedMessageHash(termsHash));

        MilestoneEscrow escrow = new MilestoneEscrow(
            payer, payee, IERC20(address(token)), 1000e6, uint64(block.timestamp + 1 days), 0,
            m.questionHash, address(0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982), payee, 0, 0,
            "IdentityMD Oracle", "1", abi.encodePacked(r, s, v)
        );

        bytes32 contractStructHash = escrow.hashAttestation(m);

        // Independently computed the SAME way EIP-712 requires: dynamic `bytes answer` hashed via
        // keccak256, everything else raw-encoded — this is the exact same computation viem's
        // hashTypedData does internally, done here by hand in Solidity as a cross-check.
        bytes32 ATTESTATION_TYPEHASH = keccak256(
            "OracleAttestation(bytes32 requestId,uint256 chainId,bytes32 questionHash,uint8 answerType,bytes answer,uint256 figure,uint64 fromBlock,uint64 toBlock,bytes32 blockHash,bytes32 panelJobId,uint64 issuedAt,uint64 expiresAt)"
        );
        bytes32 independentStructHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH, m.requestId, m.chainId, m.questionHash, m.answerType,
                keccak256(m.answer), m.figure, m.fromBlock, m.toBlock, m.blockHash, m.panelJobId, m.issuedAt, m.expiresAt
            )
        );

        assertEq(contractStructHash, independentStructHash, "contract's hashAttestation must match the hand-computed EIP-712 struct hash");

        // Full end-to-end: with the domain set to IMD's real verifyingContract (0x1234...7890, not
        // this escrow's own address, since we can't deploy exactly there), does the REAL captured
        // signature recover to IMD's real reported signer against THIS contract's own digest logic?
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("IdentityMD Oracle")),
                keccak256(bytes("1")),
                uint256(1),
                address(0x1234567890123456789012345678901234567890)
            )
        );
        bytes32 realDigest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, contractStructHash));
        bytes memory realSignature = hex"56ad79550bcfe2e08e453819f60873340e9ae2134c2222a65f7ff2546cc49e5249dcbd1dfb4fd3804cd936c9a1f56164aebbf6707ea07d0f315a0d49cf6fde511b";
        address recovered = ECDSA.recover(realDigest, realSignature);
        assertEq(recovered, address(0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982), "must recover to IMD's real reported oracle signer");
    }
}
