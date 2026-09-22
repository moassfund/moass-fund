// SPDX-License-Identifier: AGPL-3.0-only
// Forked from NetNet Capital (AGPL-3.0-only). Renamed NET -> MOASS and modified for
// Moass Fund; see ../SOURCE.md for provenance and reference/ for the unmodified original.
pragma solidity ^0.8.24;

import {ITaxCollector} from "./interfaces/ITaxCollector.sol";
import {IPTEAM} from "./interfaces/IPTEAM.sol";
import {IPairOracle} from "./interfaces/IPairOracle.sol";
import {IERC20, IERC20Metadata} from "./interfaces/external/IERC20.sol";
import {IUniswapV2Pair, IUniswapV2Router02} from "./interfaces/external/IUniswapV2.sol";
import {Constants} from "./Constants.sol";
import {FixedPointMath} from "./libraries/FixedPointMath.sol";
import {Wired} from "./abstract/Wired.sol";

/// @title TaxCollector — trading-tax accrual and conversion (specs/tax.md §4)
/// @notice MOASS tax accrues here during swaps (collect-then-convert; this
///         contract never re-enters the pool inside a taxed transfer).
///         `convert()` is permissionless (Q12): batch-swaps MOASS → USDG on the
///         canonical pool, clip-limited to TAX_SWAP_MAX_CLIP_BPS of pool MOASS
///         reserves and TWAP-bounded by TAX_SWAP_MAX_DEV_BPS, then splits
///         proceeds by the deterministic decay (mechanism §4):
///         teamBps = 400 × (1 − v), treasuryBps = 500 − teamBps, where v is
///         pTEAM's vestedFraction — one clock, no admin setter.
contract TaxCollector is ITaxCollector, Wired {
    error ZeroAmount();
    error ClipTooLarge();
    error SlippageExceeded();
    error TransferFailed();

    IERC20 public immutable moass;
    IERC20 public immutable usdg;
    IUniswapV2Router02 public immutable router;
    IUniswapV2Pair public immutable pairContract;
    IPairOracle public immutable oracle;
    address public immutable treasury;
    address public immutable teamWallet;
    bool private immutable _moassIsToken0;
    uint256 private immutable _usdgWadFactor;

    IPTEAM public pTeam;

    constructor(
        address moass_,
        address usdg_,
        address router_,
        address pair_,
        address oracle_,
        address treasury_,
        address teamWallet_
    ) {
        moass = IERC20(_nonZero(moass_));
        usdg = IERC20(_nonZero(usdg_));
        router = IUniswapV2Router02(_nonZero(router_));
        pairContract = IUniswapV2Pair(_nonZero(pair_));
        oracle = IPairOracle(_nonZero(oracle_));
        treasury = _nonZero(treasury_);
        teamWallet = _nonZero(teamWallet_);
        _moassIsToken0 = IUniswapV2Pair(pair_).token0() == moass_;
        _usdgWadFactor = 10 ** (18 - IERC20Metadata(usdg_).decimals());
    }

    /// @notice One-time wiring (pTEAM ↔ TaxCollector deploy cycle).
    function wire(address pTeam_) external wiring {
        pTeam = IPTEAM(_nonZero(pTeam_));
    }

    /// @inheritdoc ITaxCollector
    function convert(uint256 moassAmount, uint256 minUsdgOutRaw) external {
        _checkWired();
        if (moassAmount == 0) revert ZeroAmount();

        // Clip bound: keep swaps small relative to pool depth.
        (uint112 r0, uint112 r1,) = pairContract.getReserves();
        uint112 moassReserve = _moassIsToken0 ? r0 : r1;
        if (moassAmount * Constants.BPS > uint256(moassReserve) * Constants.TAX_SWAP_MAX_CLIP_BPS) {
            revert ClipTooLarge();
        }

        // TWAP bound: reverts on stale oracle (D1) — no conversion without a
        // live TWAP.
        uint256 twap = oracle.twapMoassUsdg();
        uint256 expectedWad = FixedPointMath.mulDiv(moassAmount, twap, Constants.MOASS_UNIT);
        uint256 minAllowedRaw = expectedWad * (Constants.BPS - Constants.TAX_SWAP_MAX_DEV_BPS)
            / Constants.BPS / _usdgWadFactor;
        uint256 minOut = minUsdgOutRaw > minAllowedRaw ? minUsdgOutRaw : minAllowedRaw;

        uint256 usdgBefore = usdg.balanceOf(address(this));
        if (!moass.approve(address(router), moassAmount)) revert TransferFailed();
        address[] memory path = new address[](2);
        path[0] = address(moass);
        path[1] = address(usdg);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            moassAmount, minOut, path, address(this), block.timestamp
        );
        uint256 usdgOut = usdg.balanceOf(address(this)) - usdgBefore;
        if (usdgOut < minOut) revert SlippageExceeded();

        uint256 teamShare = usdgOut * teamBps() / Constants.TAX_TOTAL_BPS;
        uint256 treasuryShare = usdgOut - teamShare;
        if (teamShare != 0 && !usdg.transfer(teamWallet, teamShare)) revert TransferFailed();
        if (!usdg.transfer(treasury, treasuryShare)) revert TransferFailed();
        emit Converted(moassAmount, usdgOut, teamShare, treasuryShare);
    }

    /// @inheritdoc ITaxCollector
    function teamBps() public view returns (uint256) {
        uint256 v = pTeam.vestedFraction(); // WAD, clamps at 1e18 forever
        return Constants.TAX_TEAM_START_BPS * (Constants.WAD - v) / Constants.WAD;
    }

    /// @inheritdoc ITaxCollector
    function treasuryBps() external view returns (uint256) {
        return Constants.TAX_TOTAL_BPS - teamBps();
    }

    /// @inheritdoc ITaxCollector
    function pendingMoass() external view returns (uint256) {
        return moass.balanceOf(address(this));
    }
}
