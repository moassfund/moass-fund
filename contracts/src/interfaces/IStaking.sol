// SPDX-License-Identifier: AGPL-3.0-only
// Forked from NetNet Capital (AGPL-3.0-only). Renamed NET -> MOASS and modified for
// Moass Fund; see ../SOURCE.md for provenance and reference/ for the unmodified original.
pragma solidity ^0.8.24;

/// @title IStaking — MOASS ⇄ sMOASS (shareholder dividend program)
/// @notice Stake MOASS 1:1 for sMOASS; balances grow via epoch rebases
///         (EPOCH_LENGTH = 8 hours). `rebase()` is permissionless once the
///         epoch has elapsed: it pulls the Distributor mint (RFV-capped) and
///         rebases sMOASS (specs/mechanism.md §2–3). Disabled until
///         GenesisBond.finalize().
interface IStaking {
    event Staked(address indexed from, address indexed to, uint256 amount);
    event Unstaked(address indexed from, address indexed to, uint256 amount);
    event Rebased(uint256 indexed epoch, uint256 distributed);

    /// @notice Stakes `amount` MOASS from the caller, minting sMOASS to `to`.
    /// @return The sMOASS amount credited (1:1 moass of any warmup).
    function stake(address to, uint256 amount) external returns (uint256);

    /// @notice Burns `amount` sMOASS from the caller, returning MOASS to `to`.
    /// @return The MOASS amount returned (1:1).
    function unstake(address to, uint256 amount) external returns (uint256);

    /// @notice Advances the epoch if elapsed: distributor mint → sMOASS rebase.
    ///         Permissionless; also checkpoints the TWAP oracle (OPEN_QUESTIONS D1).
    function rebase() external;

    /// @notice Current epoch state.
    /// @return length Epoch length in seconds (8 hours).
    /// @return number Epoch counter.
    /// @return end   Timestamp at which the current epoch can be rebased.
    /// @return distribute MOASS queued for distribution at next rebase.
    function epoch()
        external
        view
        returns (uint64 length, uint64 number, uint64 end, uint256 distribute);

    /// @notice True once staking has been enabled by GenesisBond.finalize().
    function enabled() external view returns (bool);

    /// @notice Enables staking and starts the epoch clock. GenesisBond only, once.
    function enable() external;

    /// @notice Warmup period in epochs (DEFAULT 0 — TUNE BEFORE DEPLOY).
    function warmupEpochs() external view returns (uint256);

    /// @notice Total MOASS held for stakers (backs all sMOASS fragments 1:1).
    function totalStaked() external view returns (uint256);
}
