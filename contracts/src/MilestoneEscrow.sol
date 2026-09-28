// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// Oracle-settled escrow between a payer and a payee, resolved by a signed IMD OracleAttestation.
contract MilestoneEscrow is EIP712 {
    using SafeERC20 for IERC20;

    enum State {
        Funded,
        Released,
        Refunded
    }

    // Domain name/version and full field ordering are NOT yet verified against a live IMD attestation.
    struct Attestation {
        uint256 requestId;
        uint256 chainId;
        bytes32 questionHash;
        string answerType;
        bool answer;
        string figure;
        uint256 fromBlock;
        uint256 toBlock;
        string panelJobId;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(uint256 requestId,uint256 chainId,bytes32 questionHash,string answerType,bool answer,string figure,uint256 fromBlock,uint256 toBlock,string panelJobId,uint64 issuedAt,uint64 expiresAt)"
    );

    uint16 public constant MAX_FEE_BPS = 200;
    uint16 public constant BPS_DENOMINATOR = 10000;

    address public immutable payer;
    address public immutable payee;
    IERC20 public immutable token;
    uint256 public immutable amount;
    uint64 public immutable deadline;
    uint64 public immutable grace;
    bytes32 public immutable questionHash;
    address public immutable oracleSigner;
    address public immutable feeRecipient;
    uint16 public immutable feeBps;
    uint64 public immutable challengeWindow;

    State public state;
    uint256 public trueAt;
    mapping(address => uint256) public owed;

    event TrueAttested(uint256 indexed requestId, uint256 trueAt);
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
        token.safeTransferFrom(_payer, address(this), _amount);
        // rejects fee-on-transfer, rebasing, or otherwise lossy tokens that would under-fund every payout path
        if (_token.balanceOf(address(this)) - balanceBefore != _amount) revert UnsupportedToken();
    }

    function submitAttestation(Attestation calldata m, bytes calldata sig) external {
        if (state != State.Funded) revert NotFunded();
        if (trueAt != 0) revert AlreadyResolvedTrue();
        if (m.chainId != block.chainid) revert BadChainId();
        if (m.questionHash != questionHash) revert BadQuestionHash();
        if (keccak256(bytes(m.answerType)) != keccak256(bytes("bool"))) revert BadAnswerType();
        if (block.timestamp > m.expiresAt) revert Expired();

        bytes32 digest = _hashTypedDataV4(_hashAttestation(m));
        address signer = ECDSA.recover(digest, sig);
        if (signer != oracleSigner) revert BadSigner();

        if (m.answer) {
            trueAt = block.timestamp;
            emit TrueAttested(m.requestId, trueAt);
        } else {
            state = State.Refunded;
            emit Refunded(amount);
            owed[payer] += amount;
        }
    }

    function release() external {
        if (trueAt == 0) revert NotYetTrue();
        if (block.timestamp < trueAt + challengeWindow) revert ChallengeWindowNotElapsed();
        if (state != State.Funded) revert NotFunded();

        state = State.Released;
        uint256 fee = (amount * feeBps) / BPS_DENOMINATOR;
        uint256 payeeAmount = amount - fee;
        emit Released(payeeAmount, fee);
        owed[payee] += payeeAmount;
        if (fee > 0) owed[feeRecipient] += fee;
    }

    function reclaim() external {
        if (trueAt != 0) revert AlreadyTrue();
        if (state != State.Funded) revert NotFunded();
        if (block.timestamp <= uint256(deadline) + uint256(grace)) revert TooEarly();

        state = State.Refunded;
        emit Refunded(amount);
        owed[payer] += amount;
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
}
