// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "../src/interfaces/external/IERC20.sol";

/// @notice Morpho Blue, the subset a leveraged sleeve needs.
interface IMorpho {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
    function supplyCollateral(MarketParams memory m, uint256 assets, address onBehalf, bytes calldata data)
        external;
    function withdrawCollateral(MarketParams memory m, uint256 assets, address onBehalf, address receiver)
        external;
    function borrow(MarketParams memory m, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256, uint256);
    function repay(MarketParams memory m, uint256 assets, uint256 shares, address onBehalf, bytes calldata data)
        external
        returns (uint256, uint256);
    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function market(bytes32 id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );
    function accrueInterest(MarketParams memory m) external;
}

interface IOracle {
    function price() external view returns (uint256);
}

/// @notice Can the treasury actually run a levered GME position on Morpho?
///
/// This proves the integration against the live protocol before any vault is
/// written around it. The question that decides the design is not "does the
/// call succeed" but "is there anything to borrow": a leveraged sleeve is only
/// as real as the loan-side liquidity behind it.
///
/// Requires network access; skipped when the RPC is unreachable so an offline
/// `forge test` still passes.
contract MorphoProbeTest is Test {
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address internal constant GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// GME collateral, USDG loan, 62.5% LLTV. The deepest of the three.
    bytes32 internal constant MARKET_ID = 0x4979137c23c8fb519cd507adc290944c3c2120e8a3191547531fced28360e9c2;

    bool internal forked;
    IMorpho.MarketParams internal params;

    modifier onlyForked() {
        if (!forked) return;
        _;
    }

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("robinhood")) {
            forked = MORPHO.code.length > 0;
        } catch {
            forked = false;
        }
        if (!forked) return;
        params = IMorpho(MORPHO).idToMarketParams(MARKET_ID);
    }

    function test_theMarketIsTheOneWeThinkItIs() public onlyForked {
        assertEq(params.collateralToken, GME, "collateral is tokenised GME");
        assertEq(params.loanToken, USDG, "loan asset is USDG");
        assertEq(params.lltv, 0.625e18, "62.5% LLTV");
        assertGt(IOracle(params.oracle).price(), 0, "oracle prices the pair");
    }

    /// @dev Morpho oracle scale is 36 + loanDecimals - collateralDecimals,
    ///      so USDG(6)/GME(18) prices at 1e24.
    function test_theOracleAgreesWithSpotWithinReason() public onlyForked {
        uint256 usdgPerGme = IOracle(params.oracle).price() / 1e24;
        console.log("oracle GME price, USDG:", usdgPerGme);
        assertGt(usdgPerGme, 1, "a share is worth more than a dollar");
        assertLt(usdgPerGme, 1_000, "and less than a thousand");
    }

    /// @notice Supplying collateral is unconstrained: it is the borrow side
    ///         that decides whether leverage is possible at all.
    function test_collateralCanBeSupplied() public onlyForked {
        uint256 amount = 10e18; // 10 GME
        deal(GME, address(this), amount);
        IERC20(GME).approve(MORPHO, amount);

        IMorpho(MORPHO).supplyCollateral(params, amount, address(this), "");

        (,, uint128 collateral) = IMorpho(MORPHO).position(MARKET_ID, address(this));
        assertEq(uint256(collateral), amount, "collateral is credited");
    }

    /// @notice THE question. A 2x sleeve needs to borrow about 50% of the
    ///         collateral's value; this reports what the market can actually
    ///         lend right now.
    function test_howMuchCanActuallyBeBorrowed() public onlyForked {
        uint256 collateralGme = 10e18;
        deal(GME, address(this), collateralGme);
        IERC20(GME).approve(MORPHO, collateralGme);
        IMorpho(MORPHO).supplyCollateral(params, collateralGme, address(this), "");

        IMorpho(MORPHO).accrueInterest(params);
        (uint128 totalSupplyAssets,, uint128 totalBorrowAssets,,,) = IMorpho(MORPHO).market(MARKET_ID);
        uint256 available = totalSupplyAssets > totalBorrowAssets ? totalSupplyAssets - totalBorrowAssets : 0;

        uint256 collateralValueUsdg = collateralGme * IOracle(params.oracle).price() / 1e36;
        uint256 wantedFor2x = collateralValueUsdg / 2;

        console.log("collateral value, USDG :", collateralValueUsdg / 1e6);
        console.log("needed for 2x, USDG    :", wantedFor2x / 1e6);
        console.log("market liquidity, USDG :", available / 1e6);

        if (available == 0) {
            console.log("VERDICT: nothing to borrow. Leverage is impossible today.");
            return;
        }

        // Borrow what the market can actually serve, capped by our own LTV need.
        uint256 attempt = available < wantedFor2x ? available : wantedFor2x;
        IMorpho(MORPHO).borrow(params, attempt, 0, address(this), address(this));

        assertEq(IERC20(USDG).balanceOf(address(this)), attempt, "USDG arrives");
        console.log("borrowed, USDG         :", attempt / 1e6);
        console.log("that is leverage of    :", (collateralValueUsdg * 100) / (collateralValueUsdg - attempt), "/100x");
    }
}
