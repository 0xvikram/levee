// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockStudio
/// @notice Test double for the Stablecoin Studio token manager used by ContainmentController tests.
/// @dev Records every call (function name, account, amount, caller) in order, and can be told to
///      return false from any function to exercise StudioCallFailed. Test-only; never deployed.
contract MockStudio {
    struct Call {
        string fn;
        address account;
        int64 amount;
        address caller;
    }

    Call[] private calls_;
    mapping(bytes32 => bool) private failing;

    /// @notice Make `fn` ("freeze", "unfreeze", "wipe", "burn", "pause", "unpause") return false or true.
    function setFail(string calldata fn, bool fail) external {
        failing[keccak256(bytes(fn))] = fail;
    }

    /// @notice Number of recorded calls.
    function callCount() external view returns (uint256) {
        return calls_.length;
    }

    /// @notice One recorded call, in call order.
    function getCall(uint256 i) external view returns (string memory fn, address account, int64 amount, address caller) {
        Call storage c = calls_[i];
        return (c.fn, c.account, c.amount, c.caller);
    }

    function _record(string memory fn, address account, int64 amount) internal returns (bool) {
        calls_.push(Call(fn, account, amount, msg.sender));
        return !failing[keccak256(bytes(fn))];
    }

    function freeze(address account) external returns (bool) { return _record("freeze", account, 0); }
    function unfreeze(address account) external returns (bool) { return _record("unfreeze", account, 0); }
    function wipe(address account, int64 amount) external returns (bool) { return _record("wipe", account, amount); }
    function burn(int64 amount) external returns (bool) { return _record("burn", address(0), amount); }
    function pause() external returns (bool) { return _record("pause", address(0), 0); }
    function unpause() external returns (bool) { return _record("unpause", address(0), 0); }
}
