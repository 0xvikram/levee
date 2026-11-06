// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStudioToken
/// @notice Minimal interface of the Stablecoin Studio v4 token manager (diamond proxy).
/// @dev The controller must hold FREEZE_ROLE, WIPE_ROLE, BURN_ROLE and PAUSE_ROLE on it.
///      Every function returns true on success; the controller treats false as a failure.
interface IStudioToken {
    /// @notice Freeze an account so it can no longer send or receive the token.
    /// @param account The account to freeze.
    /// @return success True if the Studio call succeeded.
    function freeze(address account) external returns (bool);

    /// @notice Unfreeze a previously frozen account.
    /// @param account The account to unfreeze.
    /// @return success True if the Studio call succeeded.
    function unfreeze(address account) external returns (bool);

    /// @notice Remove tokens from an account (the account must not be frozen).
    /// @param account The account to wipe.
    /// @param amount Amount in the token's smallest unit.
    /// @return success True if the Studio call succeeded.
    function wipe(address account, int64 amount) external returns (bool);

    /// @notice Burn tokens held by the token treasury.
    /// @param amount Amount in the token's smallest unit.
    /// @return success True if the Studio call succeeded.
    function burn(int64 amount) external returns (bool);

    /// @notice Pause the whole token.
    /// @return success True if the Studio call succeeded.
    function pause() external returns (bool);

    /// @notice Unpause the token.
    /// @return success True if the Studio call succeeded.
    function unpause() external returns (bool);
}

/// @title ContainmentController ("Fire Exit")
/// @notice Breach containment for a Stablecoin Studio token.
///         The watcher bot can only CLOSE things (freeze, wipe, burn, pause).
///         Anything that OPENS things again (unfreeze, unpause, changing the watcher)
///         needs 2 of the 3 admins to approve the same proposal.
/// @dev Hedera rules this contract respects:
///      - a frozen account cannot be wiped, so wipe happens before freeze, in one call;
///      - a paused token rejects freeze/wipe/burn, so pause is always the last step.
///      Admins may also call the close actions. Admins are fixed at deploy time.
contract ContainmentController {
    /// @notice The Stablecoin Studio token manager (diamond proxy) this controller acts on.
    IStudioToken public immutable token;
    /// @notice The bot address allowed to run close actions. Changed only by a SetWatcher proposal.
    address public watcher;
    /// @notice The three admins; any two of them can execute an open action.
    address[3] public admins;
    /// @notice Number of distinct admin approvals needed to execute a proposal.
    uint8 public constant THRESHOLD = 2;

    /// @notice Open actions that need 2 of 3 admin approvals.
    /// @dev Unfreeze: unfreeze `target`. Unpause: unpause the token (`target` ignored).
    ///      SetWatcher: make `target` the new watcher.
    enum Action { Unfreeze, Unpause, SetWatcher }

    /// @dev One open-action proposal. `approvedBy` tracks which admins have approved.
    struct Proposal {
        Action action;
        address target;
        uint8 approvals;
        bool executed;
        mapping(address => bool) approvedBy;
    }

    /// @notice Number of proposals created so far; also the id of the latest one (ids start at 1).
    uint256 public proposalCount;
    mapping(uint256 => Proposal) private proposals;

    /// @notice A close action completed.
    /// @param step Which action ran: "freeze", "wipe+freeze", "wipe-frozen", "burn" or "pause".
    /// @param account The affected account, or address(0) for burn and pause.
    /// @param amount The amount wiped or burned, or 0 for freeze and pause.
    /// @param incidentId The off-chain incident this action belongs to.
    event Contained(string step, address indexed account, int64 amount, bytes32 indexed incidentId);
    /// @notice An admin created a proposal (this also counts as that admin's approval).
    /// @param id The new proposal id.
    /// @param action The proposed open action.
    /// @param target The account the action applies to.
    /// @param by The admin who proposed it.
    event ProposalCreated(uint256 indexed id, Action action, address target, address indexed by);
    /// @notice An admin approved a proposal.
    /// @param id The proposal id.
    /// @param by The approving admin.
    /// @param approvals Approval count after this approval.
    event ProposalApproved(uint256 indexed id, address indexed by, uint8 approvals);
    /// @notice A proposal reached the threshold and its action ran.
    /// @param id The proposal id.
    /// @param action The executed action.
    /// @param target The account the action applied to.
    event ProposalExecuted(uint256 indexed id, Action action, address target);

    /// @notice Caller is neither the watcher nor an admin.
    error NotWatcherOrAdmin();
    /// @notice Caller is not an admin.
    error NotAdmin();
    /// @notice This admin has already approved the proposal.
    error AlreadyApproved();
    /// @notice The proposal has already been executed.
    error AlreadyExecuted();
    /// @notice A Stablecoin Studio call returned false.
    /// @param step The Studio call that failed: "freeze", "unfreeze", "wipe", "burn", "pause" or "unpause".
    error StudioCallFailed(string step);

    /// @param token_ The Stablecoin Studio token manager (diamond proxy) address.
    /// @param watcher_ The initial watcher bot address.
    /// @param admins_ The three admin addresses.
    constructor(address token_, address watcher_, address[3] memory admins_) {
        token = IStudioToken(token_);
        watcher = watcher_;
        admins = admins_;
    }

    modifier onlyWatcherOrAdmin() {
        if (msg.sender != watcher && !_isAdmin(msg.sender)) revert NotWatcherOrAdmin();
        _;
    }

    modifier onlyAdmin() {
        if (!_isAdmin(msg.sender)) revert NotAdmin();
        _;
    }

    /// @dev True if `a` is one of the three admins.
    function _isAdmin(address a) internal view returns (bool) {
        return a == admins[0] || a == admins[1] || a == admins[2];
    }

    // ---------------------------------------------------------------- close actions

    /// @notice Freeze one account (for example the company treasury, to stop all outflows).
    /// @dev Watcher or admin only. Calls Studio freeze(account).
    /// @param account The account to freeze.
    /// @param incidentId The off-chain incident id, echoed in the Contained event.
    function freezeAccount(address account, bytes32 incidentId) external onlyWatcherOrAdmin {
        if (!token.freeze(account)) revert StudioCallFailed("freeze");
        emit Contained("freeze", account, 0, incidentId);
    }

    /// @notice Wipe stolen tokens from an attacker account, then freeze it, in one transaction.
    /// @dev Watcher or admin only. Calls Studio wipe(account, amount) then freeze(account).
    ///      The account must not already be frozen; use wipeFrozen for that case.
    /// @param account The attacker account.
    /// @param amount Amount to wipe, in the token's smallest unit.
    /// @param incidentId The off-chain incident id, echoed in the Contained event.
    function wipeAndFreeze(address account, int64 amount, bytes32 incidentId) external onlyWatcherOrAdmin {
        if (!token.wipe(account, amount)) revert StudioCallFailed("wipe");
        if (!token.freeze(account)) revert StudioCallFailed("freeze");
        emit Contained("wipe+freeze", account, amount, incidentId);
    }

    /// @notice Same as wipeAndFreeze for an account that is already frozen.
    /// @dev Watcher or admin only. Calls Studio unfreeze, wipe, freeze in that order, all in one
    ///      transaction, so the account always ends frozen (any failure reverts everything).
    /// @param account The frozen attacker account.
    /// @param amount Amount to wipe, in the token's smallest unit.
    /// @param incidentId The off-chain incident id, echoed in the Contained event.
    function wipeFrozen(address account, int64 amount, bytes32 incidentId) external onlyWatcherOrAdmin {
        if (!token.unfreeze(account)) revert StudioCallFailed("unfreeze");
        if (!token.wipe(account, amount)) revert StudioCallFailed("wipe");
        if (!token.freeze(account)) revert StudioCallFailed("freeze");
        emit Contained("wipe-frozen", account, amount, incidentId);
    }

    /// @notice Burn unauthorised supply still held by the token treasury.
    /// @dev Watcher or admin only. Calls Studio burn(amount).
    /// @param amount Amount to burn, in the token's smallest unit.
    /// @param incidentId The off-chain incident id, echoed in the Contained event.
    function burnSupply(int64 amount, bytes32 incidentId) external onlyWatcherOrAdmin {
        if (!token.burn(amount)) revert StudioCallFailed("burn");
        emit Contained("burn", address(0), amount, incidentId);
    }

    /// @notice Pause the whole token. Always the last step.
    /// @dev Watcher or admin only. Calls Studio pause(). After this, freeze/wipe/burn are rejected
    ///      by the token, so run every other close action first.
    /// @param incidentId The off-chain incident id, echoed in the Contained event.
    function pauseToken(bytes32 incidentId) external onlyWatcherOrAdmin {
        if (!token.pause()) revert StudioCallFailed("pause");
        emit Contained("pause", address(0), 0, incidentId);
    }

    // ---------------------------------------------------------------- open actions (2 of 3)

    /// @notice Propose an open action. The proposer's approval is counted immediately.
    /// @dev Admin only. Ids start at 1. With THRESHOLD = 2 a second distinct admin executes it.
    /// @param action The open action to propose.
    /// @param target The account the action applies to (ignored for Unpause).
    /// @return id The new proposal id.
    function propose(Action action, address target) external onlyAdmin returns (uint256 id) {
        id = ++proposalCount;
        Proposal storage p = proposals[id];
        p.action = action;
        p.target = target;
        emit ProposalCreated(id, action, target, msg.sender);
        _approve(id);
    }

    /// @notice Approve an existing proposal; executes it once THRESHOLD approvals are reached.
    /// @dev Admin only. Reverts AlreadyApproved for a repeat approval and AlreadyExecuted after execution.
    /// @param id The proposal id.
    function approve(uint256 id) external onlyAdmin {
        _approve(id);
    }

    /// @dev Records msg.sender's approval and executes the proposal at the threshold.
    function _approve(uint256 id) internal {
        Proposal storage p = proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (p.approvedBy[msg.sender]) revert AlreadyApproved();
        p.approvedBy[msg.sender] = true;
        p.approvals += 1;
        emit ProposalApproved(id, msg.sender, p.approvals);
        if (p.approvals >= THRESHOLD) _execute(id);
    }

    /// @dev Runs the proposal's action. Marks it executed first; a Studio failure reverts the whole call.
    function _execute(uint256 id) internal {
        Proposal storage p = proposals[id];
        p.executed = true;
        if (p.action == Action.Unfreeze) {
            if (!token.unfreeze(p.target)) revert StudioCallFailed("unfreeze");
        } else if (p.action == Action.Unpause) {
            if (!token.unpause()) revert StudioCallFailed("unpause");
        } else if (p.action == Action.SetWatcher) {
            watcher = p.target;
        }
        emit ProposalExecuted(id, p.action, p.target);
    }

    /// @notice Read a proposal.
    /// @param id The proposal id.
    /// @return action The proposed action.
    /// @return target The account the action applies to.
    /// @return approvals Number of admin approvals so far.
    /// @return executed Whether the action has run.
    function getProposal(uint256 id) external view returns (Action action, address target, uint8 approvals, bool executed) {
        Proposal storage p = proposals[id];
        return (p.action, p.target, p.approvals, p.executed);
    }
}
