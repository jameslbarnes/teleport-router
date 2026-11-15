// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {PackedUserOperation, IAccount, IEntryPoint} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/ERC4337Utils.sol";

interface ITimelockCancel {
    function cancel(bytes32 id) external;
    function getTimestamp(bytes32 id) external view returns (uint256);
}

/// Lets a pool member cancel a waiting update with a signature alone.
///
/// This contract holds the canceller role on the upgrade timelock and nothing
/// else. A member signs with a key that holds no money, and the veto reaches
/// the chain in one of two ways:
///
///  1. Paid by this contract. The contract is an ERC-4337 account whose only
///     permitted action is to cancel. The member's agent sends a signed user
///     operation to any public bundler; the entry point asks this contract to
///     check the signature and takes the fee from this contract's deposit.
///     Nobody else has to act or hold a wallet.
///  2. Carried by anyone. A member signs "cancel operation X" (EIP-712) and
///     any address hands it to `veto`, paying the fee itself.
///
/// What it can do is bounded by the role it holds: it can cancel. It cannot
/// propose, approve or execute anything, or shorten the wait.
///
/// Members: the enroller may add one at once, because adding a member only
/// adds a power to cancel. Removing one is reserved to the timelock, so it
/// waits the full delay and can itself be vetoed.
///
/// Money: each member has a budget of their own inside the deposit. Anyone
/// may add to a member's budget. Only that member's paid vetoes spend it, and
/// each one is charged at the most it could cost, so the deposit always
/// covers every budget. Adding a member gives them no budget, so whoever may
/// add members cannot use new ones to spend what belongs to the others.
/// A member's budget leaves them only if the member is removed, which only
/// the timelock can do, after the wait. The timelock can withdraw only money
/// that belongs to no member.
contract MemberVeto is EIP712, IAccount {
    using ERC4337Utils for PackedUserOperation;

    bytes32 public constant VETO_TYPEHASH = keccak256("Veto(bytes32 operationId)");

    ITimelockCancel public immutable timelock;
    address public immutable enroller;
    IEntryPoint public immutable entryPoint;
    /// The most one paid veto may be charged, in wei. Guards a member's
    /// budget against one badly priced operation.
    uint256 public immutable maxCostPerVeto;

    mapping(address => bool) public isMember;
    /// What each member's paid vetoes may still spend, in wei.
    mapping(address => uint256) public budget;
    /// The sum of all members' budgets.
    uint256 public totalBudget;
    uint256 public memberCount;

    event MemberAdded(address indexed member, address indexed by);
    event MemberRemoved(address indexed member);
    event Funded(address indexed member, address indexed by, uint256 amount);
    event Vetoed(bytes32 indexed operationId, address indexed member, address indexed submittedBy);

    error NotAContract(address account);
    error ZeroAddress();
    error NotAllowed(address caller);
    error AlreadyMember(address member);
    error NotMember(address member);
    error NotPending(bytes32 operationId);
    error NotAVeto();
    error TooExpensive(uint256 maxCost, uint256 allowed);
    error OverBudget(address member, uint256 maxCost, uint256 budget);
    error NotUnallocated(uint256 amount, uint256 unallocated);

    constructor(
        address timelock_,
        address enroller_,
        address entryPoint_,
        uint256 maxCostPerVeto_,
        address[] memory members
    ) EIP712("Router insights member veto", "1") {
        if (timelock_.code.length == 0) revert NotAContract(timelock_);
        if (entryPoint_.code.length == 0) revert NotAContract(entryPoint_);
        if (enroller_ == address(0)) revert ZeroAddress();
        timelock = ITimelockCancel(timelock_);
        enroller = enroller_;
        entryPoint = IEntryPoint(entryPoint_);
        maxCostPerVeto = maxCostPerVeto_;
        for (uint256 i = 0; i < members.length; ++i) {
            _add(members[i], msg.sender);
        }
    }

    // ------------------------------------------------------------------
    // Members
    // ------------------------------------------------------------------

    /// Adds a member. Takes effect at once. The new member has no budget
    /// until someone funds it.
    function addMember(address member) external {
        if (msg.sender != enroller && msg.sender != address(timelock)) revert NotAllowed(msg.sender);
        _add(member, msg.sender);
    }

    /// Removes a member. Only the timelock may call this, so it waits the
    /// full delay first. What was left of the member's budget stays in the
    /// deposit, belonging to nobody.
    function removeMember(address member) external {
        if (msg.sender != address(timelock)) revert NotAllowed(msg.sender);
        if (!isMember[member]) revert NotMember(member);
        isMember[member] = false;
        totalBudget -= budget[member];
        budget[member] = 0;
        memberCount -= 1;
        emit MemberRemoved(member);
    }

    // ------------------------------------------------------------------
    // Money
    // ------------------------------------------------------------------

    /// Adds to one member's budget. Anyone may.
    function fund(address member) external payable {
        if (!isMember[member]) revert NotMember(member);
        budget[member] += msg.value;
        totalBudget += msg.value;
        entryPoint.depositTo{value: msg.value}(address(this));
        emit Funded(member, msg.sender, msg.value);
    }

    /// The whole deposit: every member's budget plus what belongs to nobody.
    function pot() public view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    /// Takes out money that belongs to no member (what is left over because
    /// vetoes are charged at their maximum, and the budgets of removed
    /// members). Only the timelock may, after the wait.
    function withdraw(address payable to, uint256 amount) external {
        if (msg.sender != address(timelock)) revert NotAllowed(msg.sender);
        uint256 unallocated = pot() - totalBudget;
        if (amount > unallocated) revert NotUnallocated(amount, unallocated);
        entryPoint.withdrawTo(to, amount);
    }

    // ------------------------------------------------------------------
    // Way 1: paid by this contract (ERC-4337)
    // ------------------------------------------------------------------

    /// Called by the entry point before it runs a user operation. Accepts
    /// exactly one kind: a call to `vetoAsMember(operationId, member)` signed
    /// by `member`, a current member, in that member's own nonce sequence,
    /// with no paymaster or factory, at a cost within the limit and within
    /// that member's budget. Reads and writes only this contract's own
    /// storage, as the rules for unstaked accounts require.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256)
        external
        returns (uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert NotAllowed(msg.sender);
        bytes calldata callData = userOp.callData;
        if (
            callData.length != 68 || bytes4(callData[:4]) != this.vetoAsMember.selector || userOp.initCode.length != 0
                || userOp.paymasterAndData.length != 0
        ) revert NotAVeto();
        (, address member) = abi.decode(callData[4:], (bytes32, address));
        // The upper 192 bits of the nonce name the sequence. Each member may
        // use only their own, so one member cannot use up another's.
        if (userOp.nonce >> 64 != uint256(uint160(member))) revert NotAVeto();

        uint256 maxCost =
            (userOp.verificationGasLimit() + userOp.callGasLimit() + userOp.preVerificationGas) * userOp.maxFeePerGas();
        if (maxCost > maxCostPerVeto) revert TooExpensive(maxCost, maxCostPerVeto);

        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(userOpHash, userOp.signature);
        if (err != ECDSA.RecoverError.NoError || signer != member || !isMember[member]) {
            return ERC4337Utils.SIG_VALIDATION_FAILED;
        }

        // Charged at the most the entry point could take for this operation,
        // whether or not the cancel then succeeds. The entry point takes that
        // much or less from the deposit, so the deposit never falls below
        // the sum of the budgets.
        uint256 left = budget[member];
        if (maxCost > left) revert OverBudget(member, maxCost, left);
        budget[member] = left - maxCost;
        totalBudget -= maxCost;
        return ERC4337Utils.SIG_VALIDATION_SUCCESS;
    }

    /// The one action a user operation may take. The entry point calls this
    /// only after `validateUserOp` accepted `member`'s signature for it.
    function vetoAsMember(bytes32 operationId, address member) external {
        if (msg.sender != address(entryPoint)) revert NotAllowed(msg.sender);
        _cancel(operationId, member);
    }

    // ------------------------------------------------------------------
    // Way 2: carried by anyone
    // ------------------------------------------------------------------

    /// Cancels a waiting operation on a member's signature. Anyone may call.
    ///
    /// The signature names the operation and nothing about when it is due, on
    /// purpose: whoever proposes can cancel an operation and schedule the same
    /// one again, and a member's objection has to survive that. So the same
    /// signature cancels that operation every time it is scheduled, for as
    /// long as the signer is a member. A different operation (other calls or
    /// another salt) has another id and needs its own veto.
    function veto(bytes32 operationId, bytes calldata signature) external {
        address member = ECDSA.recover(vetoDigest(operationId), signature);
        if (!isMember[member]) revert NotMember(member);
        _cancel(operationId, member);
    }

    /// The value a member signs for `veto` (EIP-712, bound to this chain and contract).
    function vetoDigest(bytes32 operationId) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VETO_TYPEHASH, operationId)));
    }

    // ------------------------------------------------------------------

    function _cancel(bytes32 operationId, address member) private {
        // 0 means not scheduled, 1 means already executed.
        if (timelock.getTimestamp(operationId) <= 1) revert NotPending(operationId);
        timelock.cancel(operationId);
        emit Vetoed(operationId, member, msg.sender);
    }

    function _add(address member, address by) private {
        if (member == address(0)) revert ZeroAddress();
        if (isMember[member]) revert AlreadyMember(member);
        isMember[member] = true;
        memberCount += 1;
        emit MemberAdded(member, by);
    }
}
