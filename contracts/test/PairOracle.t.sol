// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PairOracle} from "../src/PairOracle.sol";
import {Constants} from "../src/Constants.sol";
import {MockERC20, MockPair} from "./mocks/Mocks.sol";

/// @notice The TWAP everything else prices off.
///
/// Spot price is never read. A quote is only valid from an observation aged
/// between 30 minutes and 4 hours; outside that band the oracle reverts and
/// every dependent fails closed — the Distributor mints nothing, bonds refuse
/// to sell. That is the protocol's main defence against a flash-loan print, so
/// both edges of the band are asserted.
contract PairOracleTest is Test {
    PairOracle internal oracle;
    MockPair internal pair;
    MockERC20 internal moass;
    MockERC20 internal usdg;

    bool internal moassFirst;

    function setUp() public {
        // Start at a realistic unix time: the min-interval check compares
        // against a zero-initialised `lastCheckpointAt`.
        vm.warp(1_800_000_000);

        moass = new MockERC20("Moass Fund", "MOASS", 9);
        usdg = new MockERC20("USDG", "USDG", 6);
        pair = new MockPair(address(moass), address(usdg));
        moassFirst = address(moass) < address(usdg);

        oracle = new PairOracle(address(pair), address(moass), address(usdg));
    }

    /// @dev Sets the pool to `moassWhole` MOASS against `usdgWhole` USDG, i.e.
    ///      a spot price of usdgWhole/moassWhole dollars per MOASS.
    function _setPool(uint256 moassWhole, uint256 usdgWhole) internal {
        uint112 m = uint112(moassWhole * 1e9);
        uint112 u = uint112(usdgWhole * 1e6);
        pair.setReserves(moassFirst ? m : u, moassFirst ? u : m);
    }

    /// @dev Establishes a usable observation: poke, then let it age past the
    ///      minimum window.
    function _seedObservation() internal {
        oracle.checkpoint();
        skip(Constants.TWAP_MIN_WINDOW);
    }

    // ── Configuration ──

    function test_windowBand() public view {
        assertEq(oracle.twapMinWindow(), 30 minutes);
        assertEq(oracle.twapMaxWindow(), 4 hours);
        assertEq(oracle.pair(), address(pair));
        assertEq(oracle.moassIsToken0(), moassFirst);
    }

    function test_priceScale_bridges9DecimalMoassAnd6DecimalUsdg() public view {
        // 10^(18 + 9 − 6)
        assertEq(oracle.priceScale(), 1e21);
    }

    // ── Checkpointing ──

    function test_checkpoint_isANoopBeforeLiquidityExists() public {
        oracle.checkpoint();
        assertEq(oracle.lastCheckpointAt(), 0, "an empty pool records nothing");
    }

    function test_checkpoint_recordsOnceLiquidityExists() public {
        _setPool(1_000, 2_000);
        oracle.checkpoint();
        assertEq(oracle.lastCheckpointAt(), block.timestamp);
    }

    function test_checkpoint_ignoresRepeatsInsideTheMinimumInterval() public {
        _setPool(1_000, 2_000);
        oracle.checkpoint();
        uint256 first = oracle.lastCheckpointAt();

        skip(Constants.CHECKPOINT_MIN_INTERVAL - 1);
        oracle.checkpoint();
        assertEq(oracle.lastCheckpointAt(), first, "spacing is enforced, not merely suggested");

        skip(1);
        oracle.checkpoint();
        assertEq(oracle.lastCheckpointAt(), block.timestamp);
    }

    function test_checkpoint_isPermissionless() public {
        _setPool(1_000, 2_000);
        vm.prank(makeAddr("anyone"));
        oracle.checkpoint();
        assertEq(oracle.lastCheckpointAt(), block.timestamp);
    }

    // ── Reading the TWAP ──

    function test_twap_revertsWithNoObservation() public {
        _setPool(1_000, 2_000);
        vm.expectRevert(PairOracle.NoObservation.selector);
        oracle.twapMoassUsdg();
    }

    function test_twap_revertsUntilAnObservationIsOldEnough() public {
        _setPool(1_000, 2_000);
        oracle.checkpoint();

        skip(Constants.TWAP_MIN_WINDOW - 1);
        vm.expectRevert(PairOracle.NoObservation.selector);
        oracle.twapMoassUsdg();

        skip(1);
        assertGt(oracle.twapMoassUsdg(), 0, "usable at exactly the minimum window");
    }

    function test_twap_pricesAStablePool() public {
        _setPool(1_000, 2_000); // $2 per MOASS
        _seedObservation();

        assertApproxEqRel(oracle.twapMoassUsdg(), 2e18, 0.0001e18);
    }

    function test_twap_scalesWithThePool() public {
        _setPool(1_000, 23_340); // GME-ish, $23.34
        _seedObservation();

        assertApproxEqRel(oracle.twapMoassUsdg(), 23.34e18, 0.0001e18);
    }

    /// @dev The anti-manipulation property: a price that only existed for a
    ///      moment barely moves the average.
    function test_twap_isTimeWeightedNotSpot() public {
        _setPool(1_000, 2_000); // $2 for the whole window
        _seedObservation();

        // Someone slams the pool to $20 right before the read.
        _setPool(1_000, 20_000);

        uint256 twap = oracle.twapMoassUsdg();
        assertLt(twap, 3e18, "a last-second spike does not become the price");
        assertApproxEqRel(twap, 2e18, 0.01e18);
    }

    function test_twap_averagesASustainedMove() public {
        _setPool(1_000, 2_000);
        oracle.checkpoint();

        // Half the window at $2, half at $4.
        skip(Constants.TWAP_MIN_WINDOW / 2);
        _setPool(1_000, 4_000);
        skip(Constants.TWAP_MIN_WINDOW / 2);

        assertApproxEqRel(oracle.twapMoassUsdg(), 3e18, 0.01e18, "the average of the two halves");
    }

    // ── Failing closed ──

    function test_twap_revertsOnceTheObservationExceedsTheMaximumWindow() public {
        _setPool(1_000, 2_000);
        oracle.checkpoint();

        skip(Constants.TWAP_MAX_WINDOW);
        assertGt(oracle.twapMoassUsdg(), 0, "still valid at exactly 4 hours");

        skip(1);
        vm.expectRevert(PairOracle.WindowOutOfBand.selector);
        oracle.twapMoassUsdg();
    }

    /// @dev A stale oracle is never permanently broken: one poke from anyone,
    ///      then a 30-minute wait, and dependents resume.
    function test_aStaleOracleCanBeRevivedByAnyone() public {
        _setPool(1_000, 2_000);
        oracle.checkpoint();
        skip(Constants.TWAP_MAX_WINDOW + 1);

        vm.expectRevert(PairOracle.WindowOutOfBand.selector);
        oracle.twapMoassUsdg();

        vm.prank(makeAddr("keeper"));
        oracle.checkpoint();
        skip(Constants.TWAP_MIN_WINDOW);

        assertApproxEqRel(oracle.twapMoassUsdg(), 2e18, 0.01e18, "revived");
    }

    function test_twap_prefersTheNewestUsableObservation() public {
        _setPool(1_000, 2_000);
        oracle.checkpoint();

        // A newer checkpoint at a different price, then age it past the minimum.
        skip(Constants.CHECKPOINT_MIN_INTERVAL);
        _setPool(1_000, 4_000);
        oracle.checkpoint();
        skip(Constants.TWAP_MIN_WINDOW);

        // The window used should be the newer one, which sat entirely at $4.
        assertApproxEqRel(oracle.twapMoassUsdg(), 4e18, 0.01e18);
    }

    /// @dev The ring is sized so a slot is only reused after the whole buffer
    ///      duration, by which time the observation is out of band anyway.
    function test_ringSurvivesAFullDayOfCheckpoints() public {
        _setPool(1_000, 2_000);

        for (uint256 i = 0; i < 48; i++) {
            oracle.checkpoint();
            skip(Constants.CHECKPOINT_MIN_INTERVAL);
        }

        assertApproxEqRel(oracle.twapMoassUsdg(), 2e18, 0.01e18, "still quoting after 24h of pokes");
    }

    // ── Fuzz ──

    function testFuzz_twapMatchesTheStablePoolPrice(uint64 usdgWhole) public {
        uint256 quote = bound(uint256(usdgWhole), 1, 100_000);
        _setPool(1_000, quote);
        _seedObservation();

        // price = quote / 1000 dollars per MOASS, in WAD.
        assertApproxEqRel(oracle.twapMoassUsdg(), quote * 1e18 / 1_000, 0.001e18);
    }
}
