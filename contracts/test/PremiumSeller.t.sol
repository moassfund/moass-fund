// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PremiumSeller} from "../src/PremiumSeller.sol";
import {Constants} from "../src/Constants.sol";
import {MockERC20, MockOracle, MockTreasury, MockPair, MockRouter, MockGenesisBond} from "./mocks/Mocks.sol";

/// @notice The mirror of the buyback: the standing ask into euphoria.
///
/// Above 2x backing — deliberately above K = 1.75, so the treasury only sells
/// once emissions are already maxed — anyone may mint a 25bps slice of the
/// pool's MOASS, sell it into the pool, and sweep the proceeds to reserves.
/// The mint is transient: it is backed by the USDG that arrives in the same
/// transaction, so the sale is accretive rather than dilutive.
///
/// Rate-limited to once an hour and bounded by TWAP, and it fails closed on a
/// stale oracle. The UI has no screen for this.
contract PremiumSellerTest is Test {
    PremiumSeller internal seller;
    MockERC20 internal moass;
    MockERC20 internal usdg;
    MockPair internal pair;
    MockRouter internal router;
    MockOracle internal oracle;
    MockTreasury internal treasury;
    MockGenesisBond internal genesis;

    bool internal moassFirst;

    function setUp() public {
        vm.warp(1_800_000_000);

        moass = new MockERC20("Moass Fund", "MOASS", 9);
        usdg = new MockERC20("USDG", "USDG", 6);
        pair = new MockPair(address(moass), address(usdg));
        moassFirst = address(moass) < address(usdg);
        router = new MockRouter(moass, usdg);
        oracle = new MockOracle();
        treasury = new MockTreasury(moass, address(usdg));
        genesis = new MockGenesisBond();

        seller = new PremiumSeller(
            address(moass), address(usdg), address(router), address(pair),
            address(treasury), address(oracle), address(genesis)
        );
        treasury.setMinter(address(seller), true);
        genesis.setFinalizeTime(uint64(block.timestamp));

        // Pool holds 1,000,000 MOASS; backing $1; market $3 (a 3x premium).
        pair.setReserves(
            moassFirst ? uint112(1_000_000e9) : uint112(3_000_000e6),
            moassFirst ? uint112(3_000_000e6) : uint112(1_000_000e9)
        );
        treasury.setBackingPerToken(1e18);
        oracle.setTwap(3e18);
        router.setRate(3e18);

        skip(Constants.PREMIUM_MIN_INTERVAL);
    }

    // ── Parameters ──

    function test_parameters() public view {
        assertEq(seller.premiumThresholdWad(), 2e18, "sells only above 2x backing");
        assertEq(Constants.PREMIUM_CLIP_BPS, 25, "25 bps of pool MOASS per execution");
        assertEq(Constants.PREMIUM_MIN_INTERVAL, 1 hours);
        assertEq(Constants.PREMIUM_MAX_DEV_BPS, 100);
    }

    function test_thresholdSitsAboveTheEmissionsCap() public view {
        // Emissions max out at K = 1.75x; the treasury only starts selling at
        // 2x, so it never competes with its own emissions ramp.
        assertGt(Constants.PREMIUM_THRESHOLD_WAD, Constants.K_WAD);
    }

    function test_clipSize_isTwentyFiveBpsOfPoolMoass() public view {
        assertEq(seller.clipSize(), 1_000_000e9 * 25 / 10_000, "2,500 MOASS");
    }

    // ── Execution ──

    function test_execute_sellsAClipAndSweepsToTreasury() public {
        uint256 supplyBefore = moass.totalSupply();

        (uint256 sold, uint256 out) = seller.execute(0);

        assertEq(sold, 2_500e9);
        assertEq(out, 7_500e6, "2,500 MOASS at $3");
        assertEq(usdg.balanceOf(address(treasury)), 7_500e6, "proceeds land in reserves");
        assertEq(moass.totalSupply(), supplyBefore + sold, "the clip was minted to be sold");
        assertEq(moass.balanceOf(address(seller)), 0, "nothing is retained");
    }

    /// @dev The mint is only safe because the proceeds land in the same
    ///      transaction: selling at $3 against $1 backing adds more reserves
    ///      per token than it adds supply.
    function test_execute_isAccretiveNotDilutive() public {
        moass.mint(makeAddr("float"), 1_000_000e9);
        usdg.mint(address(treasury), 1_000_000e6);

        uint256 backingBefore = usdg.balanceOf(address(treasury)) * 1e12 * 1e9 / moass.totalSupply();
        seller.execute(0);
        uint256 backingAfter = usdg.balanceOf(address(treasury)) * 1e12 * 1e9 / moass.totalSupply();

        assertGt(backingAfter, backingBefore, "selling above backing raises backing");
    }

    function test_execute_isPermissionless() public {
        vm.prank(makeAddr("keeper"));
        seller.execute(0);
        assertGt(usdg.balanceOf(address(treasury)), 0);
    }

    // ── When it refuses ──

    function test_execute_revertsBelowTheThreshold() public {
        oracle.setTwap(1.9e18); // under 2x backing

        vm.expectRevert(PremiumSeller.NotActive.selector);
        seller.execute(0);
    }

    function test_execute_revertsAtExactlyTheThreshold() public {
        oracle.setTwap(2e18); // strictly greater is required

        vm.expectRevert(PremiumSeller.NotActive.selector);
        seller.execute(0);
    }

    function test_execute_revertsBeforeGenesisIsFinalised() public {
        genesis.setFinalizeTime(0);

        vm.expectRevert(PremiumSeller.NotActive.selector);
        seller.execute(0);
    }

    function test_execute_revertsOnAStaleOracle() public {
        oracle.setStale(true);

        vm.expectRevert();
        seller.execute(0);
    }

    function test_execute_enforcesTheHourlyInterval() public {
        seller.execute(0);

        vm.expectRevert(PremiumSeller.IntervalNotElapsed.selector);
        seller.execute(0);

        skip(Constants.PREMIUM_MIN_INTERVAL);
        seller.execute(0);
    }

    function test_execute_enforcesTheTwapFloorOnProceeds() public {
        router.setRate(2.5e18); // ~17% under the $3 TWAP

        vm.expectRevert(bytes("MockRouter: INSUFFICIENT_OUTPUT_AMOUNT"));
        seller.execute(0);
    }

    function test_execute_acceptsAFillJustInsideTheTwapBound() public {
        router.setRate(2.98e18); // within 1% of TWAP

        (, uint256 out) = seller.execute(0);
        assertGt(out, 0);
    }

    function test_execute_honoursAStricterCallerMinimum() public {
        vm.expectRevert(bytes("MockRouter: INSUFFICIENT_OUTPUT_AMOUNT"));
        seller.execute(100_000e6);
    }

    // ── active() ──

    function test_active_isTrueWhenAllConditionsHold() public view {
        assertTrue(seller.active());
    }

    function test_active_isFalseBelowTheThreshold() public {
        oracle.setTwap(1.5e18);
        assertFalse(seller.active());
    }

    function test_active_isFalseWithinTheInterval() public {
        seller.execute(0);
        assertFalse(seller.active(), "rate-limited");
    }

    function test_active_isFalseOnAStaleOracle() public {
        oracle.setStale(true);
        assertFalse(seller.active());
    }

    function test_active_isFalseBeforeGenesis() public {
        genesis.setFinalizeTime(0);
        assertFalse(seller.active());
    }

    function test_active_isFalseWithAnEmptyPool() public {
        pair.setReserves(0, 0);
        assertFalse(seller.active(), "no pool, no clip");
    }

    // ── Fuzz ──

    function testFuzz_clipIsAlwaysTwentyFiveBpsOfReserves(uint96 reserve) public {
        uint256 moassReserve = bound(uint256(reserve), 1e9, 1_000_000_000e9);
        pair.setReserves(
            moassFirst ? uint112(moassReserve) : uint112(1_000e6),
            moassFirst ? uint112(1_000e6) : uint112(moassReserve)
        );

        assertEq(seller.clipSize(), moassReserve * 25 / 10_000);
    }

    function testFuzz_neverSellsBelowTwoTimesBacking(uint128 twap_, uint128 backing_) public {
        uint256 twap = bound(uint256(twap_), 1e15, 1_000e18);
        uint256 backing = bound(uint256(backing_), 1e15, 1_000e18);
        oracle.setTwap(twap);
        router.setRate(twap);
        treasury.setBackingPerToken(backing);

        if (twap <= backing * 2) {
            vm.expectRevert(PremiumSeller.NotActive.selector);
            seller.execute(0);
        } else {
            seller.execute(0);
        }
    }
}
