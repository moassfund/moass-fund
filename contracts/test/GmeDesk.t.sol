// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GmeDesk} from "../src/GmeDesk.sol";
import {Wired} from "../src/abstract/Wired.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// @notice The leveraged GME sleeve.
///
/// The property that matters most is what a compromised manager key can and
/// cannot do. It can move the sleeve to a pre-agreed venue and lose it there by
/// trading badly. It cannot send GME to an address of its choosing, cannot
/// reach the treasury's liquid reserves, and cannot inflate backing by claiming
/// a profit it has not realised.
contract GmeDeskTest is Test {
    GmeDesk internal desk;
    MockERC20 internal gme;

    address internal treasury;
    address internal manager;
    address internal venue;
    address internal attacker;

    function setUp() public {
        vm.warp(1_800_000_000);
        treasury = makeAddr("treasury");
        manager = makeAddr("teamMultisig");
        venue = makeAddr("perpVenue");
        attacker = makeAddr("attacker");

        gme = new MockERC20("GameStop Robinhood Token", "GME", 18);

        address[] memory venues = new address[](1);
        venues[0] = venue;
        desk = new GmeDesk(address(gme), manager, venues);
        desk.wire(treasury);

        gme.mint(treasury, 10_000e18);
        vm.prank(treasury);
        gme.approve(address(desk), type(uint256).max);
    }

    function _fund(uint256 amount) internal {
        vm.prank(treasury);
        desk.deposit(amount, treasury);
    }

    function _open(uint256 collateral) internal {
        // 3x: 100 GME of collateral carries 300 GME of exposure, funded by
        // borrowing 200 GME worth of quote at the entry price.
        vm.prank(manager);
        desk.openPosition(venue, collateral, collateral * 3, 23.34e18, collateral * 2 * 2334 / 100);
    }

    // ── Construction ──

    function test_metadata() public view {
        assertEq(address(desk.asset()), address(gme));
        assertEq(desk.decimals(), 18, "matches GME, not the 6 a stablecoin would use");
        assertEq(desk.treasury(), treasury);
        assertEq(desk.manager(), manager);
        assertTrue(desk.isVenue(venue));
        assertEq(desk.venues().length, 1);
    }

    function test_wire_isSingleUse() public {
        vm.expectRevert(Wired.AlreadyWired.selector);
        desk.wire(attacker);
    }

    function test_wire_onlyDeployer() public {
        address[] memory venues = new address[](1);
        venues[0] = venue;
        GmeDesk fresh = new GmeDesk(address(gme), manager, venues);

        vm.prank(attacker);
        vm.expectRevert(Wired.NotDeployer.selector);
        fresh.wire(attacker);
    }

    function test_depositRevertsBeforeWiring() public {
        address[] memory venues = new address[](1);
        venues[0] = venue;
        GmeDesk fresh = new GmeDesk(address(gme), manager, venues);

        vm.prank(treasury);
        vm.expectRevert(Wired.NotWired.selector);
        fresh.deposit(1e18, treasury);
    }

    // ── Deposits and withdrawals ──

    function test_deposit_onlyTreasury() public {
        gme.mint(attacker, 100e18);
        vm.startPrank(attacker);
        gme.approve(address(desk), type(uint256).max);
        vm.expectRevert(GmeDesk.NotTreasury.selector);
        desk.deposit(100e18, attacker);
        vm.stopPrank();
    }

    function test_deposit_mintsSharesOneToOneWhileFlat() public {
        _fund(1_000e18);

        assertEq(desk.totalAssets(), 1_000e18);
        assertEq(desk.balanceOf(treasury), 1_000e18);
        assertEq(desk.convertToAssets(desk.balanceOf(treasury)), 1_000e18);
    }

    function test_withdraw_returnsReservesToTheTreasury() public {
        _fund(1_000e18);

        vm.prank(treasury);
        desk.withdraw(400e18, treasury, treasury);

        assertEq(gme.balanceOf(treasury), 9_400e18);
        assertEq(desk.totalAssets(), 600e18);
    }

    /// @dev The hard guarantee: there is no path that sends GME anywhere but a
    ///      pre-agreed venue or the treasury.
    function test_withdraw_cannotBeDirectedAnywhereButTheTreasury() public {
        _fund(1_000e18);

        vm.prank(treasury);
        vm.expectRevert(GmeDesk.OnlyTreasuryMayReceive.selector);
        desk.withdraw(100e18, attacker, treasury);
    }

    function test_withdraw_onlyTreasuryMayCall() public {
        _fund(1_000e18);

        vm.prank(manager);
        vm.expectRevert(GmeDesk.NotTreasury.selector);
        desk.withdraw(100e18, treasury, treasury);
    }

    function test_redeem_cannotBeDirectedAnywhereButTheTreasury() public {
        _fund(1_000e18);

        vm.prank(treasury);
        vm.expectRevert(GmeDesk.OnlyTreasuryMayReceive.selector);
        desk.redeem(100e18, attacker, treasury);
    }

    function test_withdraw_revertsWhenTheSleeveIsCommitted() public {
        _fund(1_000e18);
        _open(900e18);

        vm.prank(treasury);
        vm.expectRevert(GmeDesk.InsufficientLiquid.selector);
        desk.withdraw(500e18, treasury, treasury);

        // What is still liquid remains available.
        vm.prank(treasury);
        desk.withdraw(100e18, treasury, treasury);
    }

    function test_maxWithdraw_reportsOnlyWhatIsLiquid() public {
        _fund(1_000e18);
        _open(900e18);

        assertEq(desk.maxWithdraw(treasury), 100e18, "committed collateral is not withdrawable");
    }

    // ── Opening a position ──

    function test_openPosition_onlyManager() public {
        _fund(1_000e18);

        vm.prank(attacker);
        vm.expectRevert(GmeDesk.NotManager.selector);
        desk.openPosition(venue, 100e18, 300e18, 23.34e18, 4_668e18);
    }

    function test_openPosition_onlyToAKnownVenue() public {
        _fund(1_000e18);

        vm.prank(manager);
        vm.expectRevert(GmeDesk.UnknownVenue.selector);
        desk.openPosition(attacker, 100e18, 300e18, 23.34e18, 4_668e18);
    }

    function test_openPosition_movesCollateralAndRecordsTheTerms() public {
        _fund(1_000e18);
        _open(600e18);

        assertEq(gme.balanceOf(venue), 600e18, "collateral is at the venue");
        assertEq(desk.liquidAssets(), 400e18);
        assertEq(desk.deployedAssets(), 600e18);

        (address v, uint256 collateral, uint256 sizeUnits, uint256 entry,,, uint64 openedAt) =
            desk.position();
        assertEq(v, venue);
        assertEq(collateral, 600e18);
        assertEq(sizeUnits, 1_800e18, "3x exposure");
        assertEq(entry, 23.34e18);
        assertEq(openedAt, block.timestamp);
    }

    /// @dev Opening a position must not change what the protocol thinks it
    ///      owns — the GME only moves from liquid to committed.
    function test_openPosition_doesNotChangeBacking() public {
        _fund(1_000e18);
        uint256 before = desk.totalAssets();

        _open(600e18);

        assertEq(desk.totalAssets(), before, "cost accounting: no gain on opening");
        assertEq(desk.convertToAssets(desk.balanceOf(treasury)), before);
    }

    function test_openPosition_rejectsASecondPosition() public {
        _fund(1_000e18);
        _open(300e18);

        vm.prank(manager);
        vm.expectRevert(GmeDesk.PositionOpen.selector);
        desk.openPosition(venue, 100e18, 300e18, 23.34e18, 4_668e18);
    }

    function test_openPosition_cannotExceedLiquid() public {
        _fund(100e18);

        vm.prank(manager);
        vm.expectRevert(GmeDesk.InsufficientLiquid.selector);
        desk.openPosition(venue, 200e18, 600e18, 23.34e18, 9_336e18);
    }

    function test_leverage_isReportedFromTheRecordedTerms() public {
        _fund(1_000e18);
        _open(300e18);

        assertEq(desk.leverageWad(), 3e18, "3x");
    }

    function test_leverage_isZeroWhenFlat() public view {
        assertEq(desk.leverageWad(), 0);
    }

    // ── Settling ──

    function test_settle_realisesAProfitIntoBacking() public {
        _fund(1_000e18);
        _open(600e18);

        // The venue returns more than went in: a 10% GME move at 3x.
        gme.mint(venue, 180e18); // the venue's own profit payout
        vm.prank(venue);
        gme.transfer(address(desk), 600e18 + 180e18);

        vm.prank(manager);
        int256 pnl = desk.settlePosition();

        assertEq(pnl, 180e18, "profit realised on settlement");
        assertEq(desk.realisedPnl(), 180e18);
        assertEq(desk.totalAssets(), 1_180e18, "backing rose only once the gain was real");
        assertEq(desk.deployedAssets(), 0);
    }

    function test_settle_realisesALossImmediately() public {
        _fund(1_000e18);
        _open(600e18);

        // A 20% adverse move at 3x wipes 60% of the collateral.
        vm.prank(venue);
        gme.transfer(address(desk), 240e18);

        vm.prank(manager);
        int256 pnl = desk.settlePosition();

        assertEq(pnl, -360e18);
        assertEq(desk.totalAssets(), 640e18, "the loss lands in backing at once");
    }

    /// @dev A liquidation is the extreme case: nothing comes back.
    function test_settle_handlesATotalLiquidation() public {
        _fund(1_000e18);
        _open(1_000e18);

        vm.prank(manager);
        int256 pnl = desk.settlePosition();

        assertEq(pnl, -1_000e18, "the whole sleeve is gone");
        assertEq(desk.totalAssets(), 0);
        assertEq(desk.convertToAssets(desk.balanceOf(treasury)), 0);
    }

    function test_settle_onlyManager() public {
        _fund(1_000e18);
        _open(600e18);

        vm.prank(attacker);
        vm.expectRevert(GmeDesk.NotManager.selector);
        desk.settlePosition();
    }

    function test_settle_revertsWithNoPosition() public {
        _fund(1_000e18);

        vm.prank(manager);
        vm.expectRevert(GmeDesk.NoPosition.selector);
        desk.settlePosition();
    }

    // ── Maintaining a position ──

    function test_addCollateral_defendsThePositionWithoutChangingBacking() public {
        _fund(1_000e18);
        _open(500e18);
        uint256 before = desk.totalAssets();

        vm.prank(manager);
        desk.addCollateral(200e18);

        assertEq(desk.deployedAssets(), 700e18);
        assertEq(gme.balanceOf(venue), 700e18);
        assertEq(desk.totalAssets(), before, "a top-up moves GME, it does not create any");
    }

    function test_addCollateral_onlyManager() public {
        _fund(1_000e18);
        _open(500e18);

        vm.prank(attacker);
        vm.expectRevert(GmeDesk.NotManager.selector);
        desk.addCollateral(100e18);
    }

    function test_updateTerms_cannotMoveAnyGme() public {
        _fund(1_000e18);
        _open(500e18);
        uint256 liquidBefore = desk.liquidAssets();

        vm.prank(manager);
        desk.updateTerms(2_000e18, 25e18, 10_000e18);

        (, uint256 collateral, uint256 sizeUnits, uint256 entry, uint256 debt,,) = desk.position();
        assertEq(sizeUnits, 2_000e18);
        assertEq(entry, 25e18);
        assertEq(debt, 10_000e18);
        assertEq(collateral, 500e18, "collateral is not a reportable field");
        assertEq(desk.liquidAssets(), liquidBefore, "no GME moved");
    }

    function test_updateTerms_onlyManager() public {
        _fund(1_000e18);
        _open(500e18);

        vm.prank(attacker);
        vm.expectRevert(GmeDesk.NotManager.selector);
        desk.updateTerms(1e18, 1e18, 1e18);
    }

    // ── The trust boundary, stated as tests ──

    function test_managerCannotExtractToAnArbitraryAddress() public {
        _fund(1_000e18);

        // Every path that moves GME, tried as the manager.
        vm.startPrank(manager);
        vm.expectRevert(GmeDesk.UnknownVenue.selector);
        desk.openPosition(attacker, 100e18, 300e18, 1e18, 1e18);

        vm.expectRevert(GmeDesk.NotTreasury.selector);
        desk.withdraw(100e18, attacker, treasury);

        vm.expectRevert(GmeDesk.NotTreasury.selector);
        desk.redeem(100e18, attacker, treasury);
        vm.stopPrank();

        assertEq(gme.balanceOf(attacker), 0, "nothing escaped");
        assertEq(desk.totalAssets(), 1_000e18);
    }

    function test_managerCannotInflateBackingByClaimingAProfit() public {
        _fund(1_000e18);
        _open(600e18);

        // Claim a wildly profitable position without any GME coming back.
        vm.prank(manager);
        desk.updateTerms(10_000e18, 1e18, 0);

        assertEq(desk.totalAssets(), 1_000e18, "reported terms never feed backing");
    }

    // ── Fuzz ──

    function testFuzz_totalAssetsIsAlwaysLiquidPlusCommitted(uint96 fund_, uint96 collateral_) public {
        uint256 fundAmount = bound(uint256(fund_), 1e18, 10_000e18);
        uint256 collateral = bound(uint256(collateral_), 1, fundAmount);

        _fund(fundAmount);
        _open(collateral);

        assertEq(desk.totalAssets(), desk.liquidAssets() + desk.deployedAssets());
        assertEq(desk.totalAssets(), fundAmount, "opening never changes the total");
    }

    function testFuzz_settlementMovesBackingByExactlyThePnl(uint96 returned_) public {
        _fund(1_000e18);
        _open(600e18);
        uint256 returned = bound(uint256(returned_), 0, 5_000e18);

        gme.mint(address(desk), returned);

        vm.prank(manager);
        int256 pnl = desk.settlePosition();

        assertEq(desk.totalAssets(), uint256(int256(1_000e18) + pnl));
    }
}
