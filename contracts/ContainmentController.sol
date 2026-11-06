// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal interface of the Stablecoin Studio token manager (diamond proxy).
/// The controller must hold FREEZE_ROLE, WIPE_ROLE, BURN_ROLE and PAUSE_ROLE on it.
interface IStudioToken {
    function freeze(address account) external returns (bool);
    function unfreeze(address account) external returns (bool);
    function wipe(address account, int64 amount) external returns (bool);
    function burn(int64 amount) external returns (bool);
    function pause() external returns (bool);
    function unpause() external returns (bool);
}

/// ContainmentController ("Fire Exit")
///
/// Rule: the watcher bot can only CLOSE things (freeze, wipe, burn, pause).
/// Anything that OPENS things again (unfreeze, unpause, changing the watcher)
/// needs 2 of the 3 admins to approve the same proposal.
///
/// Hedera rules this contract respects:
/// - a frozen account cannot be wiped, so wipe happens before freeze, in one call;
/// - a paused token rejects freeze/wipe/burn, so pause is always the last step.
contract ContainmentController {
    IStudioToken public immutable token;
    address public watcher;
    address[3] public admins;
    uint8 public constant THRESHOLD = 2;

    enum Action { Unfreeze, Unpause, SetWatcher }

    struct Proposal {
        Action action;
        address target;
        uint8 approvals;
        bool executed;
        mapping(address => bool) approvedBy;
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) private proposals;

    event Contained(string step, address indexed account, int64 amount, bytes32 indexed incidentId);
    event ProposalCreated(uint256 indexed id, Action action, address target, address indexed by);
    event ProposalApproved(uint256 indexed id, address indexed by, uint8 approvals);
    event ProposalExecuted(uint256 indexed id, Action action, address target);

    error NotWatcherOrAdmin();
    error NotAdmin();
    error AlreadyApproved();
    error AlreadyExecuted();
    error StudioCallFailed(string step);

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

    function _isAdmin(address a) internal view returns (bool) {
        return a == admins[0] || a == admins[1] || a == admins[2];
    }

    // ---------------------------------------------------------------- close actions

    /// Freeze one account (for example the company treasury, to stop all outflows).
    function freezeAccount(address account, bytes32 incidentId) external onlyWatcherOrAdmin {
        if (!token.freeze(account)) revert StudioCallFailed("freeze");
        emit Contained("freeze", account, 0, incidentId);
    }

    /// Wipe stolen tokens from an attacker account, then freeze it, in one transaction.
    function wipeAndFreeze(address account, int64 amount, bytes32 incidentId) external onlyWatcherOrAdmin {
        if (!token.wipe(account, amount)) revert StudioCallFailed("wipe");
        if (!token.freeze(account)) revert StudioCallFailed("freeze");
        emit Contained("wipe+freeze", account, amount, incidentId);
    }

    /// Same as wipeAndFreeze for an account that is already frozen.
    /// Briefly unfreezes inside the same transaction and always ends frozen.
    function wipeFrozen(address account, int64 amount, bytes32 incidentId) external onlyWatcherOrAdmin {
        if (!token.unfreeze(account)) revert StudioCallFailed("unfreeze");
        if (!token.wipe(account, amount)) revert StudioCallFailed("wipe");
        if (!token.freeze(account)) revert StudioCallFailed("freeze");
        emit Contained("wipe-frozen", account, amount, incidentId);
    }

    /// Burn unauthorised supply still held by the token treasury.
    function burnSupply(int64 amount, bytes32 incidentId) external onlyWatcherOrAdmin {
        if (!token.burn(amount)) revert StudioCallFailed("burn");
        emit Contained("burn", address(0), amount, incidentId);
    }

    /// Pause the whole token. Always the last step.
    function pauseToken(bytes32 incidentId) external onlyWatcherOrAdmin {
        if (!token.pause()) revert StudioCallFailed("pause");
        emit Contained("pause", address(0), 0, incidentId);
    }

    // ---------------------------------------------------------------- open actions (2 of 3)

    function propose(Action action, address target) external onlyAdmin returns (uint256 id) {
        id = ++proposalCount;
        Proposal storage p = proposals[id];
        p.action = action;
        p.target = target;
        emit ProposalCreated(id, action, target, msg.sender);
        _approve(id);
    }

    function approve(uint256 id) external onlyAdmin {
        _approve(id);
    }

    function _approve(uint256 id) internal {
        Proposal storage p = proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (p.approvedBy[msg.sender]) revert AlreadyApproved();
        p.approvedBy[msg.sender] = true;
        p.approvals += 1;
        emit ProposalApproved(id, msg.sender, p.approvals);
        if (p.approvals >= THRESHOLD) _execute(id);
    }

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

    function getProposal(uint256 id) external view returns (Action action, address target, uint8 approvals, bool executed) {
        Proposal storage p = proposals[id];
        return (p.action, p.target, p.approvals, p.executed);
    }
}
