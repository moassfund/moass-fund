// SPDX-License-Identifier: AGPL-3.0-only
// Forked from NetNet Capital (AGPL-3.0-only). Renamed NET -> MOASS and modified for
// Moass Fund; see ../SOURCE.md for provenance and reference/ for the unmodified original.
pragma solidity ^0.8.24;

import {IPTEAM} from "./interfaces/IPTEAM.sol";
import {IGenesisBond} from "./interfaces/IGenesisBond.sol";
import {ITreasury} from "./interfaces/ITreasury.sol";
import {IERC20, IERC20Metadata} from "./interfaces/external/IERC20.sol";
import {Constants} from "./Constants.sol";
import {FixedPointMath} from "./libraries/FixedPointMath.sol";
import {Wired} from "./abstract/Wired.sol";

/// @title PTeam (pTEAM) — team option position (specs/mechanism.md §5)
/// @notice Single-holder (team multisig — Q6) option: mint MOASS at a strike of
///         exactly 1 USDG per MOASS, paid into the Treasury. Strike = the
///         backing floor, so exercise never dilutes the floor — only the
///         premium. Rights vest linearly over 30 days from
///         GenesisBond.finalize(); cumulative exercise ≤ vestedFraction ×
///         15% × circulating at each exercise. All parameters immutable.
/// @dev Float exclusions (Q5): MOASS held by Treasury, InverseBond,
///      TaxCollector, GenesisBond, BondDepository. Staked MOASS and LP-pool
///      MOASS count as circulating.
contract PTeam is IPTEAM, Wired {
    error NotHolder();
    error ExceedsVestedCap();
    error TransferFailed();

    IERC20 public immutable moass;
    IERC20 public immutable usdg;
    ITreasury public immutable treasury;
    address public immutable holder;
    uint256 private immutable _usdgWadFactor;

    IGenesisBond public genesisBond;
    address[] private _excludedFromFloat;

    uint256 public exercised;

    constructor(address moass_, address usdg_, address treasury_, address holder_) {
        moass = IERC20(_nonZero(moass_));
        usdg = IERC20(_nonZero(usdg_));
        treasury = ITreasury(_nonZero(treasury_));
        holder = _nonZero(holder_);
        _usdgWadFactor = 10 ** (18 - IERC20Metadata(usdg_).decimals());
    }

    /// @notice One-time wiring: the vest clock source and the Q5 exclusion
    ///         list, fixed forever.
    function wire(address genesisBond_, address[] calldata excludedFromFloat_) external wiring {
        genesisBond = IGenesisBond(_nonZero(genesisBond_));
        for (uint256 i = 0; i < excludedFromFloat_.length; i++) {
            _excludedFromFloat.push(_nonZero(excludedFromFloat_[i]));
        }
    }

    /// @inheritdoc IPTEAM
    function exercise(uint256 moassAmount) external {
        _checkWired();
        if (msg.sender != holder) revert NotHolder();
        if (moassAmount > exercisableNow()) revert ExceedsVestedCap();
        exercised += moassAmount;
        // Strike: 1 USDG per MOASS, rounded up so the treasury is never
        // underpaid; paid straight into reserves (adds 1 USDG of backing per
        // MOASS minted — invariant §6.4).
        uint256 paidWad =
            FixedPointMath.mulDiv(moassAmount, Constants.PTEAM_STRIKE_WAD, Constants.MOASS_UNIT);
        uint256 paidRaw = FixedPointMath.mulDivUp(paidWad, 1, _usdgWadFactor);
        if (!usdg.transferFrom(msg.sender, address(treasury), paidRaw)) revert TransferFailed();
        treasury.mintMoass(holder, moassAmount);
        emit Exercised(holder, moassAmount, paidWad);
    }

    /// @inheritdoc IPTEAM
    function vestedFraction() public view returns (uint256) {
        if (!wired) return 0;
        uint64 finalizeTime = genesisBond.finalizeTime();
        if (finalizeTime == 0) return 0;
        uint256 elapsed = block.timestamp - finalizeTime;
        if (elapsed >= Constants.VEST_DURATION) return Constants.WAD;
        return elapsed * Constants.WAD / Constants.VEST_DURATION;
    }

    /// @inheritdoc IPTEAM
    function exercisableNow() public view returns (uint256) {
        uint256 maxCumulative = FixedPointMath.mulDiv(
            vestedFraction() * Constants.PTEAM_CAP_BPS,
            circulatingSupply(),
            Constants.WAD * Constants.BPS
        );
        return maxCumulative > exercised ? maxCumulative - exercised : 0;
    }

    /// @inheritdoc IPTEAM
    function circulatingSupply() public view returns (uint256) {
        uint256 supply = moass.totalSupply();
        uint256 excluded = 0;
        for (uint256 i = 0; i < _excludedFromFloat.length; i++) {
            excluded += moass.balanceOf(_excludedFromFloat[i]);
        }
        return supply > excluded ? supply - excluded : 0;
    }

    function excludedFromFloat() external view returns (address[] memory) {
        return _excludedFromFloat;
    }

    function strikeWad() external pure returns (uint256) {
        return Constants.PTEAM_STRIKE_WAD;
    }

    function capBps() external pure returns (uint256) {
        return Constants.PTEAM_CAP_BPS;
    }
}
