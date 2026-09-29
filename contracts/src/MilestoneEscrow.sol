// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// Oracle-settled escrow between a payer and a payee, resolved by a signed IMD OracleAttestation.
contract MilestoneEscrow is EIP712 {
    using SafeERC20 for IERC20;

    enum State {
        Funded,
        Released,
        Refunded
    }

    // Struct shape, field types, the EIP-712 struct name, and the domain name (see the constructor's
    // domainName param and site/app/new's "IdentityMD Oracle" default) are all confirmed for real
    // against IMD's own dedicated GET /oracle/requests/:id/attestation endpoint, 2026-09-29 (see
    // docs/DAY-ONE-FINDINGS.md §25) — independently verified by recovering a real attestation's
    // signer with this exact scheme and matching IMD's own reported signer field. The prior version
    // of this struct (uint256 requestId, string answerType, bool answer, string figure, uint256
    // fromBlock/toBlock, string panelJobId, no blockHash) was never actually checked against a real
    // IMD signature and turned out to not match at all.
    struct Attestation {
        bytes32 requestId;
        uint256 chainId;
        bytes32 questionHash;
        uint8 answerType;
        bytes answer;
        uint256 figure;
        uint64 fromBlock;
        uint64 toBlock;
        bytes32 blockHash;
        bytes32 panelJobId;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    // Confirmed live: `answerType == 0` decodes to IMD's own "bool" answer type (recovering the real
    // signer only worked with this value, out of all 6 in IMD's documented enum order — bool,
    // address, bytes32, uint256, address[], bytes32[]). This contract only ever supports a bool
    // answer (matches its pre-existing behavior), so this is the only value ever accepted.
    uint8 private constant ANSWER_TYPE_BOOL = 0;

    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "OracleAttestation(bytes32 requestId,uint256 chainId,bytes32 questionHash,uint8 answerType,bytes answer,uint256 figure,uint64 fromBlock,uint64 toBlock,bytes32 blockHash,bytes32 panelJobId,uint64 issuedAt,uint64 expiresAt)"
    );

    uint16 public constant MAX_FEE_BPS = 200;
    uint16 public constant BPS_DENOMINATOR = 10000;
    uint64 public constant MAX_GRACE = 365 days;
    uint64 public constant MAX_CHALLENGE_WINDOW = 30 days;

    address public immutable payer;
    address public immutable payee;
    IERC20 public immutable token;
    uint256 public immutable amount;
    uint64 public immutable deadline;
    uint64 public immutable grace;
    bytes32 public immutable questionHash;
    // single point of trust by design, with no rotation path — a compromised or retired key
    // resolves every escrow it's bound to in the payer's favor; see SPEC.md's risk register
    address public immutable oracleSigner;
    address public immutable feeRecipient;
    uint16 public immutable feeBps;
    uint64 public immutable challengeWindow;

    State public state;
    uint256 public trueAt;
    uint64 public lastIssuedAt;
    mapping(address => uint256) public owed;

    event TrueAttested(bytes32 indexed requestId, uint256 trueAt);
    event TrueOverridden(bytes32 requestId, uint256 trueAt);
    event Released(uint256 payeeAmount, uint256 feeAmount);
    event Refunded(uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    error NotFunded();
    error AlreadyResolvedTrue();
    error BadChainId();
    error BadQuestionHash();
    error BadAnswerType();
    error Expired();
    error BadSigner();
    error NotYetTrue();
    error AlreadyTrue();
    error TooEarly();
    error ChallengeWindowNotElapsed();
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh();
    error InvalidPayerAuthorization();
    error UnsupportedToken();
    error NothingOwed();
    error BadIssuedAt();
    error StaleAttestation();
    error TooLate();
    error PrematureFalse();
    error BadDeadline();
    error BadGrace();
    error BadChallengeWindow();
    error BadRecipient();

    bytes32 private constant TERMS_TYPEHASH = keccak256(
        "EscrowTerms(address payer,address payee,address token,uint256 amount,uint64 deadline,uint64 grace,bytes32 questionHash,address oracleSigner,address feeRecipient,uint16 feeBps,uint64 challengeWindow)"
    );

    // Constructor pulls `amount` from payer via transferFrom (payer must pre-approve) so the contract is always
    // fully funded from the moment it exists, rather than exposing a separate fund() step with an interim unfunded state.
    // `_payerAuthorization` binds the payer's consent to these exact terms, not to whatever lands at a predicted
    // deploy address — the deploying party (e.g. IMD's workflow agent) can broadcast the transaction, but cannot
    // change any term the payer signed off on without invalidating the signature.
    constructor(
        address _payer,
        address _payee,
        IERC20 _token,
        uint256 _amount,
        uint64 _deadline,
        uint64 _grace,
        bytes32 _questionHash,
        address _oracleSigner,
        address _feeRecipient,
        uint16 _feeBps,
        uint64 _challengeWindow,
        string memory domainName,
        string memory domainVersion,
        bytes memory _payerAuthorization
    ) EIP712(domainName, domainVersion) {
        if (_payer == address(0) || _payee == address(0) || _oracleSigner == address(0) || _feeRecipient == address(0)) {
            revert ZeroAddress();
        }
        if (address(_token) == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (_deadline <= block.timestamp) revert BadDeadline();
        if (_grace > MAX_GRACE) revert BadGrace();
        if (_challengeWindow > MAX_CHALLENGE_WINDOW) revert BadChallengeWindow();
        if (
            _payee == address(_token) || _payer == address(_token) || _feeRecipient == address(_token)
                || _payee == address(this) || _payer == address(this) || _feeRecipient == address(this)
        ) revert BadRecipient();

        bytes32 termsHash = keccak256(
            abi.encode(
                TERMS_TYPEHASH,
                _payer,
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
        if (ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(termsHash), _payerAuthorization) != _payer) {
            revert InvalidPayerAuthorization();
        }

        payer = _payer;
        payee = _payee;
        token = _token;
        amount = _amount;
        deadline = _deadline;
        grace = _grace;
        questionHash = _questionHash;
        oracleSigner = _oracleSigner;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        challengeWindow = _challengeWindow;

        uint256 balanceBefore = _token.balanceOf(address(this));
        // slither-disable-next-line arbitrary-send-erc20 -- `_payer` authorized this exact transfer above, not just this address
        token.safeTransferFrom(_payer, address(this), _amount);
        // rejects fee-on-transfer, rebasing, or otherwise lossy tokens that would under-fund every payout path
        if (_token.balanceOf(address(this)) - balanceBefore != _amount) revert UnsupportedToken();
    }

    // A true answer is not final the instant it lands: while still inside `challengeWindow`, a newer,
    // oracle-signed `false` can still override it (this is what "challenge window" actually means here).
    // A second `true`, or any attestation once the window has closed, cannot change a resolved true.
    function submitAttestation(Attestation calldata m, bytes calldata sig) external {
        if (state != State.Funded) revert NotFunded();
        if (m.answerType != ANSWER_TYPE_BOOL) revert BadAnswerType();
        // `answer` is dynamic `bytes` in IMD's real scheme (ABI-encoded bool: 32 bytes, 0 or 1) —
        // decoded once here, before signature verification, so a garbage-shaped answer reverts
        // cheaply rather than reaching ECDSA.recover; either way nothing moves until the signer
        // checks out below.
        bool answer = abi.decode(m.answer, (bool));
        _checkChallengeable(answer);
        _checkAttestationTiming(m, answer);

        bytes32 digest = _hashTypedDataV4(_hashAttestation(m));
        address signer = ECDSA.recover(digest, sig);
        if (signer != oracleSigner) revert BadSigner();

        lastIssuedAt = m.issuedAt;

        if (answer) {
            trueAt = block.timestamp;
            emit TrueAttested(m.requestId, trueAt);
        } else {
            if (trueAt != 0) emit TrueOverridden(m.requestId, trueAt);
            // pays out the live balance, not the nominal `amount` — any surplus above `amount` (a stray
            // direct transfer, for example) settles with the payer instead of being stranded forever
            uint256 bal = token.balanceOf(address(this));
            state = State.Refunded;
            emit Refunded(bal);
            owed[payer] += bal;
        }
    }

    function _checkChallengeable(bool answer) private view {
        if (trueAt == 0) return;
        if (answer) revert AlreadyResolvedTrue();
        if (block.timestamp >= trueAt + challengeWindow) revert AlreadyResolvedTrue();
    }

    function _checkAttestationTiming(Attestation calldata m, bool answer) private view {
        if (m.chainId != block.chainid) revert BadChainId();
        if (m.questionHash != questionHash) revert BadQuestionHash();
        if (block.timestamp > m.expiresAt) revert Expired();
        if (m.issuedAt > block.timestamp) revert BadIssuedAt();
        // rejects any answer older than (or equal to) the one already accepted, so a stale or replayed
        // attestation can never undo a fresher one, in either direction
        if (m.issuedAt <= lastIssuedAt) revert StaleAttestation();
        // once the payer's reclaim() window is live, submitAttestation can no longer race it
        if (block.timestamp > uint256(deadline) + uint256(grace)) revert TooLate();
        // "not done as of an early check" is not proof of failure — only a false evaluated at or after
        // the deadline can settle the deal; an earlier one would end it before the payee had their full window
        if (!answer && m.issuedAt < deadline) revert PrematureFalse();
    }

    function release() external {
        if (trueAt == 0) revert NotYetTrue();
        if (block.timestamp < trueAt + challengeWindow) revert ChallengeWindowNotElapsed();
        if (state != State.Funded) revert NotFunded();

        state = State.Released;
        uint256 bal = token.balanceOf(address(this));
        // mulDiv over the live balance: never overflows regardless of amount, and captures any surplus above
        // `amount` instead of stranding it; rounds the fee down, in the payee's favor, which is deliberate
        uint256 fee = Math.mulDiv(bal, feeBps, BPS_DENOMINATOR);
        uint256 payeeAmount = bal - fee;
        emit Released(payeeAmount, fee);
        owed[payee] += payeeAmount;
        if (fee > 0) owed[feeRecipient] += fee;
    }

    function reclaim() external {
        if (trueAt != 0) revert AlreadyTrue();
        if (state != State.Funded) revert NotFunded();
        if (block.timestamp <= uint256(deadline) + uint256(grace)) revert TooEarly();

        uint256 bal = token.balanceOf(address(this));
        state = State.Refunded;
        emit Refunded(bal);
        owed[payer] += bal;
    }

    // pull payments: a blocklisted or reverting recipient can't lock the other parties' funds, and each
    // party can redirect their own payout to a clean address if their default one is compromised or blocked
    function withdraw(address to) external {
        if (to == address(0)) revert ZeroAddress();
        uint256 amt = owed[msg.sender];
        if (amt == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        token.safeTransfer(to, amt);
        emit Withdrawn(msg.sender, to, amt);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function hashAttestation(Attestation calldata m) external pure returns (bytes32) {
        return _hashAttestation(m);
    }

    function _hashAttestation(Attestation calldata m) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                m.requestId,
                m.chainId,
                m.questionHash,
                m.answerType,
                keccak256(m.answer),
                m.figure,
                m.fromBlock,
                m.toBlock,
                m.blockHash,
                m.panelJobId,
                m.issuedAt,
                m.expiresAt
            )
        );
    }
}
