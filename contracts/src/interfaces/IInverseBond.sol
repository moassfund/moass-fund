// SPDX-License-Identifier: AGPL-3.0-only
// Forked from NetNet Capital (AGPL-3.0-only). Renamed NET -> MOASS and modified for
// Moass Fund; see ../SOURCE.md for provenance and reference/ for the unmodified original.
pragma solidity ^0.8.24;

/// @title IInverseBond — standing bid below backing ("buyback program")
/// @notice Direct bonds, form FINAL 2026-07-12 (specs/treasury.md §4): any
///         MOASS holder may sell MOASS straight to the protocol at
///         `payoutPerMOASS = backingPerToken × (1 − INVERSE_SPREAD_BPS)` —
///         seller-initiated, fully permissionless, no keeper. Rational only
///         when market trades below backing × (1 − spread), so it functions
///         as the standing floor bid. All MOASS received is burned; every fill
///         pays below backing, so every fill is strictly accretive to NAV.
///         Per-epoch fill capacity: INVERSE_EPOCH_CAP_BPS of liquid
///         (non-Morpho) reserves, recomputed fresh each epoch (no rollover).
///         Fails closed when the TWAP oracle is outside its validity band
///         (mechanism §2).
interface IInverseBond {
    event InverseBonded(address indexed seller, uint256 moassBurned, uint256 usdgPaidWad);

    /// @notice Sells `moassAmount` MOASS to the protocol at `price()`. Burns the
    ///         MOASS, pays treasury USDG. Reverts beyond the epoch capacity or
    ///         when the oracle is out of band.
    /// @param minUsdgOutRaw Slippage guard in raw USDG units.
    function swap(uint256 moassAmount, uint256 minUsdgOutRaw) external returns (uint256 usdgOutRaw);

    /// @notice True when the bid can currently be hit (post-genesis, oracle
    ///         in band, capacity remaining).
    function active() external view returns (bool);

    /// @notice Current payout price: backing × (1 − spread), WAD USDG per MOASS.
    function price() external view returns (uint256);

    /// @notice Remaining fill capacity this epoch, WAD USDG.
    function capacityRemaining() external view returns (uint256);

    /// @notice Spread below backing, bps (150, DEFAULT — TUNE BEFORE DEPLOY).
    function spreadBps() external view returns (uint256);
}
