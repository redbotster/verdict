// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockFeeOnTransferToken} from "./mocks/MockFeeOnTransferToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract MilestoneEscrowTest is Test {
    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(uint256 requestId,uint256 chainId,bytes32 questionHash,string answerType,bool answer,string figure,uint256 fromBlock,uint256 toBlock,string panelJobId,uint64 issuedAt,uint64 expiresAt)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant TERMS_TYPEHASH = keccak256(
        "EscrowTerms(address payer,address payee,address token,uint256 amount,uint64 deadline,uint64 grace,bytes32 questionHash,address oracleSigner,address feeRecipient,uint16 feeBps,uint64 challengeWindow)"
    );

    string constant DOMAIN_NAME = "IMD-Attestation";
    string constant DOMAIN_VERSION = "1";

    uint256 constant AMOUNT = 1_000e6;
    uint64 constant CHALLENGE_WINDOW = 24 hours;
    uint64 constant GRACE = 7 days;
    uint16 constant FEE_BPS = 100;

    uint256 oraclePk = 0xA11CE;
    address oracleSigner;
    uint256 payerPk = 0xB0B;
    address payer;
    address payee = makeAddr("payee");
    address feeRecipient = makeAddr("feeRecipient");

    MockUSDC token;
    bytes32 questionHash = keccak256("will-it-ship");
    uint64 deadline;

    function setUp() public {
        oracleSigner = vm.addr(oraclePk);
        payer = vm.addr(payerPk);
        token = new MockUSDC();
        deadline = uint64(block.timestamp + 10 days);
    }

    function _predictAddress() internal view returns (address) {
        return vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
    }

    function _payerAuth(
        address _payee,
        IERC20 _token,
        uint256 _amount,
        uint64 _deadline,
        uint64 _grace,
        bytes32 _questionHash,
        address _oracleSigner,
        address _feeRecipient,
        uint16 _feeBps,
        uint64 _challengeWindow
    ) internal view returns (bytes memory) {
        bytes32 termsHash = keccak256(
            abi.encode(
                TERMS_TYPEHASH,
                payer,
                _payee,
                address(_token),
                _amount,
                _deadline,
                _grace,
                _questionHash,
                _oracleSigner,
                _feeRecipient,
                _feeBps,
                _challengeWindow
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, MessageHashUtils.toEthSignedMessageHash(termsHash));
        return abi.encodePacked(r, s, v);
    }

    function _deploy(uint256 amount, uint64 _deadline, uint64 grace, uint16 feeBps, uint64 challengeWindow)
        internal
        returns (MilestoneEscrow)
    {
        token.mint(payer, amount);
        address predicted = _predictAddress();
        vm.prank(payer);
        token.approve(predicted, amount);

        bytes memory auth = _payerAuth(
            payee, IERC20(address(token)), amount, _deadline, grace, questionHash, oracleSigner, feeRecipient, feeBps, challengeWindow
        );

        MilestoneEscrow escrow = new MilestoneEscrow(
            payer,
            payee,
            IERC20(address(token)),
            amount,
            _deadline,
            grace,
            questionHash,
            oracleSigner,
            feeRecipient,
            feeBps,
            challengeWindow,
            DOMAIN_NAME,
            DOMAIN_VERSION,
            auth
        );
        assertEq(address(escrow), predicted);
        return escrow;
    }

    function _deployDefault() internal returns (MilestoneEscrow) {
        return _deploy(AMOUNT, deadline, GRACE, FEE_BPS, CHALLENGE_WINDOW);
    }

    function _defaultAttestation(bool answer) internal view returns (MilestoneEscrow.Attestation memory) {
        return MilestoneEscrow.Attestation({
            requestId: 1,
            chainId: block.chainid,
            questionHash: questionHash,
            answerType: "bool",
            answer: answer,
            figure: "n/a",
            fromBlock: 100,
            toBlock: 200,
            panelJobId: "panel-1",
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 1 days)
        });
    }

    // A `false` answer only settles the deal once it's issued at or after the deadline — this warps
    // time to exactly `deadline` and builds a matching attestation, for tests that need a valid refund.
    function _deadlineFalseAttestation() internal returns (MilestoneEscrow.Attestation memory) {
        vm.warp(deadline);
        return _defaultAttestation(false);
    }

    function _structHash(MilestoneEscrow.Attestation memory m) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                m.requestId,
                m.chainId,
                m.questionHash,
                keccak256(bytes(m.answerType)),
                m.answer,
                keccak256(bytes(m.figure)),
                m.fromBlock,
                m.toBlock,
                keccak256(bytes(m.panelJobId)),
                m.issuedAt,
                m.expiresAt
            )
        );
    }

    function _domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(DOMAIN_NAME)),
                keccak256(bytes(DOMAIN_VERSION)),
                block.chainid,
                verifyingContract
            )
        );
    }

    function _digest(address verifyingContract, MilestoneEscrow.Attestation memory m) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(verifyingContract), _structHash(m)));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signWith(uint256 pk, address verifyingContract, MilestoneEscrow.Attestation memory m)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, _digest(verifyingContract, m));
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_ConstructorPullsFundsFromPayerAtDeployment() public {
        MilestoneEscrow escrow = _deployDefault();
        assertEq(token.balanceOf(payer), 0);
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
        assertEq(uint256(escrow.state()), uint256(MilestoneEscrow.State.Funded));
    }

    function test_ConstructorRevertsWhenFeeBpsExceedsCap() public {
        token.mint(payer, AMOUNT);
        address predicted = _predictAddress();
        vm.prank(payer);
        token.approve(predicted, AMOUNT);

        vm.expectRevert(MilestoneEscrow.FeeTooHigh.selector);
        new MilestoneEscrow(
            payer,
            payee,
            IERC20(address(token)),
            AMOUNT,
            deadline,
            GRACE,
            questionHash,
            oracleSigner,
            feeRecipient,
            201,
            CHALLENGE_WINDOW,
            DOMAIN_NAME,
            DOMAIN_VERSION,
            "" // feeBps is checked before the authorization, so an empty signature here is fine
        );
    }

    function test_ConstructorAcceptsFeeBpsAtCap() public {
        MilestoneEscrow escrow = _deploy(AMOUNT, deadline, GRACE, 200, CHALLENGE_WINDOW);
        assertEq(escrow.feeBps(), 200);
    }

    function testFuzz_ConstructorFeeBpsCap(uint16 feeBps) public {
        token.mint(payer, AMOUNT);
        address predicted = _predictAddress();
        vm.prank(payer);
        token.approve(predicted, AMOUNT);

        if (feeBps > 200) {
            vm.expectRevert(MilestoneEscrow.FeeTooHigh.selector);
            new MilestoneEscrow(
                payer,
                payee,
                IERC20(address(token)),
                AMOUNT,
                deadline,
                GRACE,
                questionHash,
                oracleSigner,
                feeRecipient,
                feeBps,
                CHALLENGE_WINDOW,
                DOMAIN_NAME,
                DOMAIN_VERSION,
                ""
            );
        } else {
            bytes memory auth = _payerAuth(
                payee, IERC20(address(token)), AMOUNT, deadline, GRACE, questionHash, oracleSigner, feeRecipient, feeBps, CHALLENGE_WINDOW
            );
            MilestoneEscrow escrow = new MilestoneEscrow(
                payer,
                payee,
                IERC20(address(token)),
                AMOUNT,
                deadline,
                GRACE,
                questionHash,
                oracleSigner,
                feeRecipient,
                feeBps,
                CHALLENGE_WINDOW,
                DOMAIN_NAME,
                DOMAIN_VERSION,
                auth
            );
            assertEq(escrow.feeBps(), feeBps);
        }
    }

    function test_ConstructorRevertsOnZeroAddresses() public {
        token.mint(payer, AMOUNT);
        address predicted = _predictAddress();
        vm.prank(payer);
        token.approve(predicted, AMOUNT);

        vm.expectRevert(MilestoneEscrow.ZeroAddress.selector);
        new MilestoneEscrow(
            address(0),
            payee,
            IERC20(address(token)),
            AMOUNT,
            deadline,
            GRACE,
            questionHash,
            oracleSigner,
            feeRecipient,
            FEE_BPS,
            CHALLENGE_WINDOW,
            DOMAIN_NAME,
            DOMAIN_VERSION,
            "" // zero-address is checked before the authorization, so an empty signature here is fine
        );
    }

    function test_ConstructorRevertsOnZeroAmount() public {
        vm.expectRevert(MilestoneEscrow.ZeroAmount.selector);
        new MilestoneEscrow(
            payer,
            payee,
            IERC20(address(token)),
            0,
            deadline,
            GRACE,
            questionHash,
            oracleSigner,
            feeRecipient,
            FEE_BPS,
            CHALLENGE_WINDOW,
            DOMAIN_NAME,
            DOMAIN_VERSION,
            ""
        );
    }

    function test_ConstructorRevertsOnInvalidPayerAuthorization_WrongSigner() public {
        token.mint(payer, AMOUNT);
        address predicted = _predictAddress();
        vm.prank(payer);
        token.approve(predicted, AMOUNT);

        uint256 wrongPk = 0xDEAD;
        bytes32 termsHash = keccak256(
            abi.encode(
                TERMS_TYPEHASH,
                payer,
                payee,
                address(token),
                AMOUNT,
                deadline,
                GRACE,
                questionHash,
                oracleSigner,
                feeRecipient,
                FEE_BPS,
                CHALLENGE_WINDOW
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, MessageHashUtils.toEthSignedMessageHash(termsHash));
        bytes memory badAuth = abi.encodePacked(r, s, v);

        vm.expectRevert(MilestoneEscrow.InvalidPayerAuthorization.selector);
        new MilestoneEscrow(
            payer,
            payee,
            IERC20(address(token)),
            AMOUNT,
            deadline,
            GRACE,
            questionHash,
            oracleSigner,
            feeRecipient,
            FEE_BPS,
            CHALLENGE_WINDOW,
            DOMAIN_NAME,
            DOMAIN_VERSION,
            badAuth
        );
    }

    function test_ConstructorRevertsOnInvalidPayerAuthorization_TamperedTerm() public {
        token.mint(payer, AMOUNT);
        address predicted = _predictAddress();
        vm.prank(payer);
        token.approve(predicted, AMOUNT);

        // A deployer who tries to swap in a different payee after the payer signed off on the original one:
        // the authorization is over the exact terms, so this must revert rather than silently redirecting funds.
        address attackerPayee = makeAddr("attackerPayee");
        bytes memory auth = _payerAuth(
            payee, IERC20(address(token)), AMOUNT, deadline, GRACE, questionHash, oracleSigner, feeRecipient, FEE_BPS, CHALLENGE_WINDOW
        );

        vm.expectRevert(MilestoneEscrow.InvalidPayerAuthorization.selector);
        new MilestoneEscrow(
            payer,
            attackerPayee,
            IERC20(address(token)),
            AMOUNT,
            deadline,
            GRACE,
            questionHash,
            oracleSigner,
            feeRecipient,
            FEE_BPS,
            CHALLENGE_WINDOW,
            DOMAIN_NAME,
            DOMAIN_VERSION,
            auth
        );
    }

    function test_ConstructorRevertsOnFeeOnTransferToken() public {
        MockFeeOnTransferToken fotToken = new MockFeeOnTransferToken(100); // 1%
        fotToken.mint(payer, AMOUNT);
        address predicted = _predictAddress();
        vm.prank(payer);
        fotToken.approve(predicted, AMOUNT);

        bytes memory auth = _payerAuth(
            payee, IERC20(address(fotToken)), AMOUNT, deadline, GRACE, questionHash, oracleSigner, feeRecipient, FEE_BPS, CHALLENGE_WINDOW
        );

        vm.expectRevert(MilestoneEscrow.UnsupportedToken.selector);
        new MilestoneEscrow(
            payer,
            payee,
            IERC20(address(fotToken)),
            AMOUNT,
            deadline,
            GRACE,
            questionHash,
            oracleSigner,
            feeRecipient,
            FEE_BPS,
            CHALLENGE_WINDOW,
            DOMAIN_NAME,
            DOMAIN_VERSION,
            auth
        );
    }

    // ---------------------------------------------------------------------
    // submitAttestation - happy paths
    // ---------------------------------------------------------------------

    function test_SubmitAttestation_TrueSetsTrueAtButKeepsFundedState() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);

        escrow.submitAttestation(m, sig);

        assertEq(escrow.trueAt(), block.timestamp);
        assertEq(uint256(escrow.state()), uint256(MilestoneEscrow.State.Funded));
    }

    function test_SubmitAttestation_FalseCreditsPayerImmediately() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _deadlineFalseAttestation();
        bytes memory sig = _signWith(oraclePk, address(escrow), m);

        escrow.submitAttestation(m, sig);

        assertEq(uint256(escrow.state()), uint256(MilestoneEscrow.State.Refunded));
        assertEq(escrow.owed(payer), AMOUNT);
        assertEq(escrow.trueAt(), 0);

        vm.prank(payer);
        escrow.withdraw(payer);
        assertEq(token.balanceOf(payer), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    // ---------------------------------------------------------------------
    // submitAttestation - reverts
    // ---------------------------------------------------------------------

    function test_SubmitAttestation_RevertsOnWrongSigner() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        uint256 wrongPk = 0xBEEF;
        bytes memory sig = _signWith(wrongPk, address(escrow), m);

        vm.expectRevert(MilestoneEscrow.BadSigner.selector);
        escrow.submitAttestation(m, sig);
    }

    function test_SubmitAttestation_RevertsOnWrongQuestionHash() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        m.questionHash = keccak256("some-other-question");
        bytes memory sig = _signWith(oraclePk, address(escrow), m);

        vm.expectRevert(MilestoneEscrow.BadQuestionHash.selector);
        escrow.submitAttestation(m, sig);
    }

    function test_SubmitAttestation_RevertsOnWrongChainId() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        m.chainId = block.chainid + 1;
        bytes memory sig = _signWith(oraclePk, address(escrow), m);

        vm.expectRevert(MilestoneEscrow.BadChainId.selector);
        escrow.submitAttestation(m, sig);
    }

    function test_SubmitAttestation_RevertsOnNonBoolAnswerType() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        m.answerType = "int256";
        bytes memory sig = _signWith(oraclePk, address(escrow), m);

        vm.expectRevert(MilestoneEscrow.BadAnswerType.selector);
        escrow.submitAttestation(m, sig);
    }

    function test_SubmitAttestation_RevertsWhenExpired() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        m.expiresAt = uint64(block.timestamp);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);

        vm.warp(block.timestamp + 1);
        vm.expectRevert(MilestoneEscrow.Expired.selector);
        escrow.submitAttestation(m, sig);
    }

    function test_SubmitAttestation_RevertsOnMalformedSignatureLength() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory badSig = hex"1234";

        vm.expectRevert();
        escrow.submitAttestation(m, badSig);
    }

    function test_SubmitAttestation_RevertsOnMalleatedSignature() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes32 digest = _digest(address(escrow), m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);

        // secp256k1 order n; flipping s to n - s and v produces a second valid-looking sig that OZ ECDSA rejects.
        uint256 n = 115792089237316195423570985008687907852837564279074904382605163141518161494337;
        bytes32 malleatedS = bytes32(n - uint256(s));
        uint8 malleatedV = v == 27 ? 28 : 27;
        bytes memory malleatedSig = abi.encodePacked(r, malleatedS, malleatedV);

        vm.expectRevert();
        escrow.submitAttestation(m, malleatedSig);
    }

    function test_SubmitAttestation_RevertsWhenNotFunded_AfterRelease() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory mTrue = _defaultAttestation(true);
        bytes memory sigTrue = _signWith(oraclePk, address(escrow), mTrue);
        escrow.submitAttestation(mTrue, sigTrue);

        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        escrow.release();

        MilestoneEscrow.Attestation memory mAgain = _defaultAttestation(true);
        mAgain.requestId = 2;
        bytes memory sigAgain = _signWith(oraclePk, address(escrow), mAgain);

        vm.expectRevert(MilestoneEscrow.NotFunded.selector);
        escrow.submitAttestation(mAgain, sigAgain);
    }

    function test_SubmitAttestation_RevertsWhenNotFunded_AfterFalseRefund() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory mFalse = _deadlineFalseAttestation();
        bytes memory sigFalse = _signWith(oraclePk, address(escrow), mFalse);
        escrow.submitAttestation(mFalse, sigFalse);

        MilestoneEscrow.Attestation memory mTrue = _defaultAttestation(true);
        bytes memory sigTrue = _signWith(oraclePk, address(escrow), mTrue);

        vm.expectRevert(MilestoneEscrow.NotFunded.selector);
        escrow.submitAttestation(mTrue, sigTrue);
    }

    function test_SubmitAttestation_RevertsOnSecondTrueAfterFirstTrue() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m1 = _defaultAttestation(true);
        bytes memory sig1 = _signWith(oraclePk, address(escrow), m1);
        escrow.submitAttestation(m1, sig1);

        MilestoneEscrow.Attestation memory m2 = _defaultAttestation(true);
        m2.requestId = 2;
        bytes memory sig2 = _signWith(oraclePk, address(escrow), m2);

        vm.expectRevert(MilestoneEscrow.AlreadyResolvedTrue.selector);
        escrow.submitAttestation(m2, sig2);
    }

    // ---------------------------------------------------------------------
    // Deadline binding
    // ---------------------------------------------------------------------

    function test_SubmitAttestation_RevertsOnPrematureFalse() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(false); // issuedAt is deploy-time, well before deadline
        bytes memory sig = _signWith(oraclePk, address(escrow), m);

        vm.expectRevert(MilestoneEscrow.PrematureFalse.selector);
        escrow.submitAttestation(m, sig);
    }

    function test_SubmitAttestation_RevertsOnTooLate() public {
        MilestoneEscrow escrow = _deployDefault();
        vm.warp(uint256(deadline) + uint256(GRACE) + 1);
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);

        vm.expectRevert(MilestoneEscrow.TooLate.selector);
        escrow.submitAttestation(m, sig);
    }

    function test_SubmitAttestation_RevertsOnFutureIssuedAt() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        m.issuedAt = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);

        vm.expectRevert(MilestoneEscrow.BadIssuedAt.selector);
        escrow.submitAttestation(m, sig);
    }

    // ---------------------------------------------------------------------
    // Challenge window: a fresher oracle-signed false can override a true while the window is open
    // ---------------------------------------------------------------------

    function test_SubmitAttestation_FalseOverridesTrueWithinChallengeWindow() public {
        MilestoneEscrow escrow = _deployDefault();
        vm.warp(deadline); // the resolver acts at the deadline, not before
        MilestoneEscrow.Attestation memory mTrue = _defaultAttestation(true);
        bytes memory sigTrue = _signWith(oraclePk, address(escrow), mTrue);
        escrow.submitAttestation(mTrue, sigTrue);
        assertEq(escrow.trueAt(), block.timestamp);

        vm.warp(block.timestamp + CHALLENGE_WINDOW / 2); // still inside the window
        MilestoneEscrow.Attestation memory mCorrection = _defaultAttestation(false);
        bytes memory sigCorrection = _signWith(oraclePk, address(escrow), mCorrection);
        escrow.submitAttestation(mCorrection, sigCorrection);

        assertEq(uint256(escrow.state()), uint256(MilestoneEscrow.State.Refunded));
        assertEq(escrow.owed(payer), AMOUNT);

        // release() can no longer pay the payee, even once the original window would have elapsed
        vm.warp(mTrue.issuedAt + CHALLENGE_WINDOW);
        vm.expectRevert(MilestoneEscrow.NotFunded.selector);
        escrow.release();
    }

    function test_SubmitAttestation_RevertsOnStaleOverrideAttempt() public {
        MilestoneEscrow escrow = _deployDefault();
        vm.warp(deadline);
        MilestoneEscrow.Attestation memory mTrue = _defaultAttestation(true);
        bytes memory sigTrue = _signWith(oraclePk, address(escrow), mTrue);
        escrow.submitAttestation(mTrue, sigTrue);

        // A false with issuedAt <= the true's issuedAt can't override it, even though it's still within the window.
        MilestoneEscrow.Attestation memory mStaleFalse = mTrue;
        mStaleFalse.answer = false;
        mStaleFalse.requestId = 2;
        bytes memory sigStaleFalse = _signWith(oraclePk, address(escrow), mStaleFalse);

        vm.expectRevert(MilestoneEscrow.StaleAttestation.selector);
        escrow.submitAttestation(mStaleFalse, sigStaleFalse);
    }

    function test_SubmitAttestation_RevertsOnFalseAfterChallengeWindowCloses() public {
        MilestoneEscrow escrow = _deployDefault();
        vm.warp(deadline);
        MilestoneEscrow.Attestation memory mTrue = _defaultAttestation(true);
        bytes memory sigTrue = _signWith(oraclePk, address(escrow), mTrue);
        escrow.submitAttestation(mTrue, sigTrue);

        vm.warp(block.timestamp + CHALLENGE_WINDOW); // window has fully elapsed
        MilestoneEscrow.Attestation memory mLateCorrection = _defaultAttestation(false);
        bytes memory sigLateCorrection = _signWith(oraclePk, address(escrow), mLateCorrection);

        vm.expectRevert(MilestoneEscrow.AlreadyResolvedTrue.selector);
        escrow.submitAttestation(mLateCorrection, sigLateCorrection);
    }

    // ---------------------------------------------------------------------
    // Domain separator binding
    // ---------------------------------------------------------------------

    function test_SignatureForDifferentInstanceDoesNotVerify() public {
        MilestoneEscrow escrowA = _deployDefault();
        MilestoneEscrow escrowB = _deployDefault();

        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sigForA = _signWith(oraclePk, address(escrowA), m);

        // Valid on A...
        escrowA.submitAttestation(m, sigForA);
        assertEq(escrowA.trueAt(), block.timestamp);

        // ...but must not verify against B, whose domain separator binds a different verifyingContract.
        vm.expectRevert(MilestoneEscrow.BadSigner.selector);
        escrowB.submitAttestation(m, sigForA);
    }

    // ---------------------------------------------------------------------
    // release()
    // ---------------------------------------------------------------------

    function test_Release_RevertsBeforeChallengeWindowElapses() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);

        vm.warp(block.timestamp + CHALLENGE_WINDOW - 1);
        vm.expectRevert(MilestoneEscrow.ChallengeWindowNotElapsed.selector);
        escrow.release();
    }

    function test_Release_RevertsBeforeAnyAttestation() public {
        MilestoneEscrow escrow = _deployDefault();
        vm.expectRevert(MilestoneEscrow.NotYetTrue.selector);
        escrow.release();
    }

    function test_Release_CreditsPayeeAndFeeRecipient_WithdrawableExactlyAtChallengeWindow() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);

        vm.warp(block.timestamp + CHALLENGE_WINDOW);

        uint256 fee = (AMOUNT * FEE_BPS) / 10000;
        uint256 payeeAmount = AMOUNT - fee;

        escrow.release();

        assertEq(uint256(escrow.state()), uint256(MilestoneEscrow.State.Released));
        assertEq(escrow.owed(payee), payeeAmount);
        assertEq(escrow.owed(feeRecipient), fee);
        // release() only credits entitlements; tokens move on withdraw()
        assertEq(token.balanceOf(address(escrow)), AMOUNT);

        vm.prank(payee);
        escrow.withdraw(payee);
        vm.prank(feeRecipient);
        escrow.withdraw(feeRecipient);

        assertEq(token.balanceOf(payee), payeeAmount);
        assertEq(token.balanceOf(feeRecipient), fee);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testFuzz_Release_ChallengeWindowBoundary(uint256 offset) public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);
        uint256 trueAt = escrow.trueAt();

        offset = bound(offset, 0, 365 days);
        vm.warp(trueAt + offset);

        if (offset < CHALLENGE_WINDOW) {
            vm.expectRevert(MilestoneEscrow.ChallengeWindowNotElapsed.selector);
            escrow.release();
        } else {
            escrow.release();
            assertEq(uint256(escrow.state()), uint256(MilestoneEscrow.State.Released));
        }
    }

    function test_Release_RevertsAfterAlreadyReleased() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        escrow.release();

        vm.expectRevert(MilestoneEscrow.NotFunded.selector);
        escrow.release();
    }

    function test_Release_CallableByAnyone() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);

        vm.prank(makeAddr("rando"));
        escrow.release();
        assertEq(uint256(escrow.state()), uint256(MilestoneEscrow.State.Released));
    }

    function testFuzz_Release_FeeNeverExceedsCap(uint16 feeBps) public {
        feeBps = uint16(bound(feeBps, 0, 200));
        MilestoneEscrow escrow = _deploy(AMOUNT, deadline, GRACE, feeBps, CHALLENGE_WINDOW);
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        escrow.release();

        uint256 fee = escrow.owed(feeRecipient);
        assertLe(fee * 10000, AMOUNT * 200);
        assertEq(fee + escrow.owed(payee), AMOUNT);
    }

    // ---------------------------------------------------------------------
    // withdraw()
    // ---------------------------------------------------------------------

    function test_Withdraw_RevertsWhenNothingOwed() public {
        MilestoneEscrow escrow = _deployDefault();
        vm.expectRevert(MilestoneEscrow.NothingOwed.selector);
        escrow.withdraw(payer);
    }

    function test_Withdraw_CanRedirectToADifferentAddress() public {
        // Models a payee whose usual address is blocklisted by the token issuer: they can still
        // pull their entitlement out to a clean address they control, instead of being locked out.
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        escrow.release();

        address rescueAddress = makeAddr("payeeRescue");
        uint256 owedAmount = escrow.owed(payee);

        vm.prank(payee);
        escrow.withdraw(rescueAddress);

        assertEq(token.balanceOf(rescueAddress), owedAmount);
        assertEq(token.balanceOf(payee), 0);
        assertEq(escrow.owed(payee), 0);
    }

    function test_Withdraw_RevertsOnZeroAddress() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _deadlineFalseAttestation();
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);

        vm.prank(payer);
        vm.expectRevert(MilestoneEscrow.ZeroAddress.selector);
        escrow.withdraw(address(0));
    }

    // ---------------------------------------------------------------------
    // reclaim()
    // ---------------------------------------------------------------------

    function test_Reclaim_RevertsBeforeDeadlinePlusGrace() public {
        MilestoneEscrow escrow = _deployDefault();
        vm.warp(uint256(deadline) + uint256(GRACE));
        vm.expectRevert(MilestoneEscrow.TooEarly.selector);
        escrow.reclaim();
    }

    function test_Reclaim_CreditsPayerAfterDeadlinePlusGrace() public {
        MilestoneEscrow escrow = _deployDefault();
        vm.warp(uint256(deadline) + uint256(GRACE) + 1);

        escrow.reclaim();

        assertEq(uint256(escrow.state()), uint256(MilestoneEscrow.State.Refunded));
        assertEq(escrow.owed(payer), AMOUNT);

        vm.prank(payer);
        escrow.withdraw(payer);
        assertEq(token.balanceOf(payer), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_Reclaim_CallableByAnyone() public {
        MilestoneEscrow escrow = _deployDefault();
        vm.warp(uint256(deadline) + uint256(GRACE) + 1);

        vm.prank(makeAddr("rando"));
        escrow.reclaim();
        assertEq(uint256(escrow.state()), uint256(MilestoneEscrow.State.Refunded));
    }

    function test_Reclaim_RevertsIfTrueAtSet_EvenBeforeRelease() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);

        vm.warp(uint256(deadline) + uint256(GRACE) + 1);
        vm.expectRevert(MilestoneEscrow.AlreadyTrue.selector);
        escrow.reclaim();
    }

    function test_Reclaim_RevertsIfTrueAtSet_EvenAfterRelease() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        escrow.release();

        vm.warp(uint256(deadline) + uint256(GRACE) + 1);
        // trueAt != 0 is checked before state, so a post-release reclaim() reverts AlreadyTrue rather than NotFunded.
        vm.expectRevert(MilestoneEscrow.AlreadyTrue.selector);
        escrow.reclaim();
    }

    function test_Reclaim_RevertsAfterAlreadyRefundedByFalseAnswer() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _deadlineFalseAttestation();
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);

        vm.warp(uint256(deadline) + uint256(GRACE) + 1);
        vm.expectRevert(MilestoneEscrow.NotFunded.selector);
        escrow.reclaim();
    }

    function test_Reclaim_RevertsAfterAlreadyReclaimed() public {
        MilestoneEscrow escrow = _deployDefault();
        vm.warp(uint256(deadline) + uint256(GRACE) + 1);
        escrow.reclaim();

        vm.expectRevert(MilestoneEscrow.NotFunded.selector);
        escrow.reclaim();
    }

    // ---------------------------------------------------------------------
    // Settlement finality / fund-destination invariants
    // ---------------------------------------------------------------------

    function test_Invariant_FundsOnlyReachPayeeViaReleaseAfterTrue() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        escrow.release();

        assertGt(escrow.owed(payee), 0);
        assertEq(escrow.owed(payer), 0);

        vm.prank(payee);
        escrow.withdraw(payee);
        assertGt(token.balanceOf(payee), 0);
        assertEq(token.balanceOf(payer), 0);
    }

    function test_Invariant_FundsOnlyReachPayerViaFalseOrReclaim() public {
        MilestoneEscrow escrowFalse = _deployDefault();
        MilestoneEscrow.Attestation memory mFalse = _deadlineFalseAttestation();
        bytes memory sigFalse = _signWith(oraclePk, address(escrowFalse), mFalse);
        escrowFalse.submitAttestation(mFalse, sigFalse);
        assertEq(escrowFalse.owed(payer), AMOUNT);
        assertEq(escrowFalse.owed(payee), 0);
        vm.prank(payer);
        escrowFalse.withdraw(payer);
        assertEq(token.balanceOf(payer), AMOUNT);

        MilestoneEscrow escrowReclaim = _deploy(AMOUNT, deadline, GRACE, FEE_BPS, CHALLENGE_WINDOW);
        vm.warp(uint256(deadline) + uint256(GRACE) + 1);
        escrowReclaim.reclaim();
        assertEq(escrowReclaim.owed(payer), AMOUNT);
        vm.prank(payer);
        escrowReclaim.withdraw(payer);
        assertEq(token.balanceOf(payer), AMOUNT * 2);
    }

    function test_Invariant_NoStateChangeSucceedsAfterSettlement() public {
        MilestoneEscrow escrow = _deployDefault();
        MilestoneEscrow.Attestation memory m = _defaultAttestation(true);
        bytes memory sig = _signWith(oraclePk, address(escrow), m);
        escrow.submitAttestation(m, sig);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        escrow.release();

        vm.expectRevert(MilestoneEscrow.NotFunded.selector);
        escrow.release();
        vm.expectRevert(MilestoneEscrow.AlreadyTrue.selector);
        escrow.reclaim();

        MilestoneEscrow.Attestation memory m2 = _defaultAttestation(true);
        m2.requestId = 99;
        bytes memory sig2 = _signWith(oraclePk, address(escrow), m2);
        vm.expectRevert(MilestoneEscrow.NotFunded.selector);
        escrow.submitAttestation(m2, sig2);
    }
}
