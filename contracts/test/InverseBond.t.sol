// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InverseBond} from "../src/InverseBond.sol";
import {Constants} from "../src/Constants.sol";
import {MockERC20, MockOracle, MockTreasury, MockGenesisBond} from "./mocks/Mocks.sol";

/// @notice The standing floor bid — the protocol's buyback.
///
/// Anyone may sell MOASS back to the treasury at `backing × (1 − 1.5%)`. The
/// MOASS is burned on the spot, so every fill raises backing for everyone left.
/// It is rational to hit only when the market trades below that, which is what
/// makes it a floor rather than a subsidy.
///
/// Two limits keep it from draining the treasury: 1% of *liquid* reserves per
/// epoch, snapshotted at the epoch's first fill so mid-epoch inflows cannot
/// inflate it, and a fail-closed oracle gate.
///
/// The UI has no screen for this yet.
contract InverseBondTest is Test {
    InverseBond internal inverse;
    MockERC20 internal moass;
    MockERC20 internal usdg;
    MockTreasury internal treasury;
    MockOracle internal oracle;
    MockGenesisBond internal genesis;

    address internal alice;

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = makeAddr("alice");

        moass = new MockERC20("Moass Fund", "MOASS", 9);
        usdg = new MockERC20("USDG", "USDG", 6);
        treasury = new MockTreasury(moass, address(usdg));
        oracle = new MockOracle();
        genesis = new MockGenesisBond();

        inverse = new InverseBond(
            address(moass), address(usdg), address(treasury), address(oracle), address(genesis)
        );
        treasury.setSpender(address(inverse), true);

        genesis.setFinalizeTime(uint64(block.timestamp));
        treasury.setBackingPerToken(2e18); // $2 of reserves behind each MOASS
        usdg.mint(address(treasury), 1_000_000e6);

        moass.mint(alice, 100_000e9);
        vm.prank(alice);
        moass.approve(address(inverse), type(uint256).max);
    }

    // ── Pricing ──

    function test_price_isBackingLessTheSpread() public view {
        // $2 × (1 − 1.5%) = $1.97
        assertEq(inverse.price(), 1.97e18);
        assertEq(inverse.spreadBps(), 150);
    }

    function test_price_movesWithBacking() public {
        treasury.setBackingPerToken(5e18);
        assertEq(inverse.price(), 4.925e18, "the floor is not fixed, it tracks the treasury");
    }

    // ── Settlement ──

    function test_swap_paysBackingLessSpreadAndBurnsTheMoass() public {
        uint256 supplyBefore = moass.totalSupply();

        vm.prank(alice);
        uint256 out = inverse.swap(1_000e9, 0);

        assertEq(out, 1_970e6, "1,000 MOASS at $1.97");
        assertEq(usdg.balanceOf(alice), 1_970e6);
        assertEq(moass.totalSupply(), supplyBefore - 1_000e9, "the MOASS is destroyed, not recycled");
    }

    /// @dev The accretion property: buying below backing and burning leaves the
    ///      remaining holders with more reserves each than before.
    function test_swap_isAccretiveToRemainingHolders() public {
        // 10,000 MOASS outstanding against $20,000 of reserves.
        uint256 reservesBefore = 20_000e18;
        uint256 supplyBefore = 10_000e9;
        moass.burn(alice, moass.balanceOf(alice) - supplyBefore);

        uint256 backingBefore = reservesBefore * 1e9 / moass.totalSupply();

        vm.prank(alice);
        inverse.swap(1_000e9, 0);

        // Paid out $1,970; burned 1,000 MOASS.
        uint256 backingAfter = (reservesBefore - 1_970e18) * 1e9 / moass.totalSupply();
        assertGt(backingAfter, backingBefore, "backing per token rose for everyone who stayed");
    }

    function test_swap_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(InverseBond.ZeroAmount.selector);
        inverse.swap(0, 0);
    }

    function test_swap_respectsCallerSlippage() public {
        vm.prank(alice);
        vm.expectRevert(InverseBond.SlippageExceeded.selector);
        inverse.swap(1_000e9, 2_000e6); // would only pay 1,970
    }

    function test_swap_isPermissionless() public {
        address stranger = makeAddr("stranger");
        moass.mint(stranger, 100e9);
        vm.startPrank(stranger);
        moass.approve(address(inverse), type(uint256).max);
        inverse.swap(100e9, 0);
        vm.stopPrank();

        assertEq(usdg.balanceOf(stranger), 197e6, "no keeper, no whitelist");
    }

    // ── Dormant until launch completes ──

    function test_swap_revertsBeforeGenesisIsFinalised() public {
        genesis.setFinalizeTime(0);

        vm.prank(alice);
        vm.expectRevert(InverseBond.NotActive.selector);
        inverse.swap(1_000e9, 0);
    }

    function test_active_isFalseBeforeGenesis() public {
        genesis.setFinalizeTime(0);
        assertFalse(inverse.active());
        assertEq(inverse.capacityRemaining(), 0);
    }

    function test_active_isTrueOnceLiveWithCapacity() public view {
        assertTrue(inverse.active());
        assertGt(inverse.capacityRemaining(), 0);
    }

    // ── Fail-closed oracle gate ──

    function test_swap_revertsOnAStaleOracle() public {
        oracle.setStale(true);

        vm.prank(alice);
        vm.expectRevert();
        inverse.swap(1_000e9, 0);
    }

    function test_active_reportsFalseOnAStaleOracle() public {
        oracle.setStale(true);
        assertFalse(inverse.active(), "the bid withdraws when pricing is not live");
    }

    // ── Epoch capacity ──

    function test_capacity_isOnePercentOfLiquidReserves() public view {
        // $1,000,000 liquid × 1% = $10,000 per epoch.
        assertEq(Constants.INVERSE_EPOCH_CAP_BPS, 100);
        assertEq(inverse.capacityRemaining(), 10_000e18);
    }

    function test_capacity_rejectsAnOversizedFill() public {
        vm.prank(alice);
        vm.expectRevert(InverseBond.ExceedsCapacity.selector);
        inverse.swap(6_000e9, 0); // ~$11,820, over the $10,000 budget
    }

    function test_capacity_drawsDownWithinAnEpoch() public {
        vm.prank(alice);
        inverse.swap(1_000e9, 0); // $1,970

        assertEq(inverse.capacityRemaining(), 10_000e18 - 1_970e18);
    }

    /// @dev The budget resets each epoch rather than accumulating, and it is
    ///      recomputed from liquid reserves — which the previous epoch's fill
    ///      has just reduced. So a heavy epoch shrinks the next one's budget,
    ///      the buyback self-throttling as reserves are drawn down.
    function test_capacity_refillsNextEpochAndDoesNotRollOver() public {
        vm.prank(alice);
        inverse.swap(1_000e9, 0); // pays out $1,970
        uint256 leftoverLastEpoch = inverse.capacityRemaining();
        assertEq(leftoverLastEpoch, 10_000e18 - 1_970e18);

        skip(Constants.EPOCH_LENGTH);

        // Liquid reserves are now $998,030, so the fresh budget is $9,980.30.
        assertEq(inverse.capacityRemaining(), 9_980.3e18, "recomputed from current reserves");
        assertGt(inverse.capacityRemaining(), leftoverLastEpoch, "a fresh budget, not a rollover");
    }

    /// @dev The budget is snapshotted at the epoch's first fill, so somebody
    ///      cannot top the treasury up mid-epoch to unlock a bigger buyback.
    function test_capacity_isSnapshottedAtTheFirstFillOfTheEpoch() public {
        vm.prank(alice);
        inverse.swap(100e9, 0); // snapshots the cap at $10,000

        usdg.mint(address(treasury), 9_000_000e6); // 10x the reserves mid-epoch

        assertEq(
            inverse.capacityRemaining(),
            10_000e18 - 197e18,
            "the budget did not grow with the deposit"
        );
    }

    function test_capacity_tracksFillsPerEpochIndex() public {
        vm.prank(alice);
        inverse.swap(1_000e9, 0);
        assertEq(inverse.filledInEpoch(0), 1_970e18);

        skip(Constants.EPOCH_LENGTH);
        vm.prank(alice);
        inverse.swap(500e9, 0);
        assertEq(inverse.filledInEpoch(1), 985e18);
        assertEq(inverse.filledInEpoch(0), 1_970e18, "history is not rewritten");
    }

    // ── Fuzz ──

    function testFuzz_payoutIsAlwaysBackingLessSpread(uint64 amount_) public {
        uint256 amount = bound(uint256(amount_), 1e9, 5_000e9);

        vm.prank(alice);
        uint256 out = inverse.swap(amount, 0);

        assertEq(out, amount * inverse.price() / 1e9 / 1e12);
    }

    function testFuzz_neverPaysAboveBacking(uint128 backing) public {
        uint256 b = bound(uint256(backing), 1e9, 1_000e18);
        treasury.setBackingPerToken(b);

        assertLt(inverse.price(), b, "the bid always sits below backing, never at or above");
    }
}
