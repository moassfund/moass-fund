// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StakedMOASS} from "../src/StakedMOASS.sol";
import {Constants} from "../src/Constants.sol";
import {Wired} from "../src/abstract/Wired.sol";

/// @notice sMOASS gons/fragments accounting.
///
/// The load-bearing property is the peg (upstream's invariant §6.5): a rebase of
/// `profit` must grow *circulating* fragments by exactly `profit` in aggregate,
/// while the Staking inventory absorbs the rest. Everything the UI shows as APY
/// rests on that, so it is tested directly rather than inferred from index().
contract StakedMOASSTest is Test {
    StakedMOASS internal s;

    address internal staking;
    address internal alice;
    address internal bob;

    uint256 internal constant INITIAL_FRAGMENTS = 5_000_000_000e9;

    function setUp() public {
        staking = makeAddr("staking");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        s = new StakedMOASS();
        s.wire(staking);
    }

    /// @dev Moves `amount` of fragments out of the Staking inventory, which is
    ///      what `Staking.stake()` does. Everything held outside Staking is
    ///      "circulating" and earns the rebase.
    function _stake(address to, uint256 amount) internal {
        vm.prank(staking);
        s.transfer(to, amount);
    }

    function _rebase(uint256 profit, uint256 epoch) internal {
        vm.prank(staking);
        s.rebase(profit, epoch);
    }

    // ── Construction and wiring ──

    function test_constructor_setsInventoryAndMetadata() public view {
        assertEq(s.name(), "Staked MOASS");
        assertEq(s.symbol(), "sMOASS");
        assertEq(s.decimals(), 9);
        assertEq(s.totalSupply(), INITIAL_FRAGMENTS);
    }

    function test_wire_assignsFullInventoryToStaking() public view {
        assertEq(s.balanceOf(staking), INITIAL_FRAGMENTS);
        assertEq(s.circulatingSupply(), 0, "nothing circulates before anyone stakes");
        assertEq(s.index(), Constants.MOASS_UNIT, "index base is 1.0");
    }

    function test_wire_revertsOnSecondCall() public {
        vm.expectRevert(Wired.AlreadyWired.selector);
        s.wire(staking);
    }

    function test_wire_revertsForNonDeployer() public {
        StakedMOASS fresh = new StakedMOASS();
        vm.prank(alice);
        vm.expectRevert(Wired.NotDeployer.selector);
        fresh.wire(staking);
    }

    function test_wire_revertsOnZeroAddress() public {
        StakedMOASS fresh = new StakedMOASS();
        vm.expectRevert(Wired.ZeroAddress.selector);
        fresh.wire(address(0));
    }

    function test_rebase_revertsBeforeWiring() public {
        StakedMOASS fresh = new StakedMOASS();
        vm.expectRevert(Wired.NotWired.selector);
        fresh.rebase(1e9, 1);
    }

    // ── The peg ──

    function test_rebase_growsCirculatingByExactlyProfit() public {
        _stake(alice, 1_000e9);
        uint256 before = s.circulatingSupply();

        _rebase(10e9, 1);

        // Integer division of gons truncates; the shortfall must be dust and
        // must never round in the holder's favour.
        uint256 grown = s.circulatingSupply() - before;
        assertApproxEqAbs(grown, 10e9, 2, "circulating grew by the distributed profit");
        assertLe(grown, 10e9, "rounding never mints more than was distributed");
    }

    function test_rebase_splitsProRataAcrossHolders() public {
        _stake(alice, 750e9);
        _stake(bob, 250e9);

        _rebase(100e9, 1);

        // 75/25 split of the 100 profit.
        assertApproxEqAbs(s.balanceOf(alice), 825e9, 2);
        assertApproxEqAbs(s.balanceOf(bob), 275e9, 2);
    }

    function test_rebase_inventoryAbsorbsTheRest() public {
        _stake(alice, 1_000e9);
        uint256 inventoryBefore = s.balanceOf(staking);
        uint256 supplyBefore = s.totalSupply();

        _rebase(10e9, 1);

        assertGt(s.totalSupply(), supplyBefore, "total supply scales up");
        assertGt(s.balanceOf(staking), inventoryBefore, "inventory scales with it");
    }

    function test_rebase_compoundsOverManyEpochs() public {
        _stake(alice, 1_000e9);

        // 0.45%/epoch (R_MAX) for 30 epochs, applied to the circulating float.
        for (uint256 i = 1; i <= 30; i++) {
            _rebase(s.circulatingSupply() * 45 / 10_000, i);
        }

        // 1000 × 1.0045^30 ≈ 1144.2
        assertApproxEqRel(s.balanceOf(alice), 1_144.2e9, 0.001e18, "compounds at the epoch rate");
        assertGt(s.index(), Constants.MOASS_UNIT, "index tracks cumulative growth");
    }

    function test_index_tracksCumulativeGrowth() public {
        _stake(alice, 1_000e9);
        _rebase(s.circulatingSupply() * 45 / 10_000, 1);

        // One 0.45% epoch: index ≈ 1.0045.
        assertApproxEqRel(s.index(), 1.0045e9, 0.0001e18);
    }

    // ── Rebase guards ──

    function test_rebase_onlyStaking() public {
        _stake(alice, 1_000e9);
        vm.prank(alice);
        vm.expectRevert(StakedMOASS.NotStaking.selector);
        s.rebase(10e9, 1);
    }

    function test_rebase_zeroProfitIsNoop() public {
        _stake(alice, 1_000e9);
        uint256 supply = s.totalSupply();

        _rebase(0, 1);

        assertEq(s.totalSupply(), supply);
        assertEq(s.balanceOf(alice), 1_000e9);
    }

    function test_rebase_withNoCirculatingSupplyIsNoop() public {
        // Nobody has staked: the whole inventory sits in Staking.
        uint256 supply = s.totalSupply();
        _rebase(10e9, 1);
        assertEq(s.totalSupply(), supply, "profit is not stranded into the inventory");
    }

    // ── ERC-20 surface ──

    function test_transfer_movesFragments() public {
        _stake(alice, 100e9);
        vm.prank(alice);
        s.transfer(bob, 40e9);

        assertEq(s.balanceOf(alice), 60e9);
        assertEq(s.balanceOf(bob), 40e9);
    }

    function test_transfer_survivesRebase() public {
        _stake(alice, 100e9);
        _rebase(s.circulatingSupply() / 10, 1); // +10%

        vm.prank(alice);
        s.transfer(bob, 55e9);

        assertApproxEqAbs(s.balanceOf(alice), 55e9, 2);
        assertEq(s.balanceOf(bob), 55e9);
    }

    function test_transfer_revertsOnInsufficientBalance() public {
        _stake(alice, 10e9);
        vm.prank(alice);
        vm.expectRevert(StakedMOASS.InsufficientBalance.selector);
        s.transfer(bob, 11e9);
    }

    function test_transfer_revertsToZeroAddress() public {
        _stake(alice, 10e9);
        vm.prank(alice);
        vm.expectRevert(Wired.ZeroAddress.selector);
        s.transfer(address(0), 1e9);
    }

    function test_transferFrom_spendsAllowance() public {
        _stake(alice, 100e9);
        vm.prank(alice);
        s.approve(bob, 30e9);

        vm.prank(bob);
        s.transferFrom(alice, bob, 30e9);

        assertEq(s.balanceOf(bob), 30e9);
        assertEq(s.allowance(alice, bob), 0);
    }

    function test_transferFrom_infiniteAllowanceIsNotDecremented() public {
        _stake(alice, 100e9);
        vm.prank(alice);
        s.approve(bob, type(uint256).max);

        vm.prank(bob);
        s.transferFrom(alice, bob, 30e9);

        assertEq(s.allowance(alice, bob), type(uint256).max);
    }

    function test_transferFrom_revertsOnInsufficientAllowance() public {
        _stake(alice, 100e9);
        vm.prank(alice);
        s.approve(bob, 10e9);

        vm.prank(bob);
        vm.expectRevert(StakedMOASS.InsufficientAllowance.selector);
        s.transferFrom(alice, bob, 11e9);
    }

    // ── Conversions ──

    function test_gonsAndBalanceRoundTrip() public {
        _stake(alice, 1_000e9);
        _rebase(7e9, 1); // make gonsPerFragment a non-round number

        uint256 gons = s.gonsForBalance(123e9);
        assertApproxEqAbs(s.balanceForGons(gons), 123e9, 1);
    }

    // ── Fuzz ──

    /// @dev The peg must hold for any plausible float and profit, not just the
    ///      hand-picked numbers above.
    function testFuzz_rebase_neverOvermints(uint96 float_, uint96 profit_) public {
        uint256 float_amount = bound(uint256(float_), 1e9, 100_000_000e9);
        uint256 profit = bound(uint256(profit_), 0, float_amount / 10);

        _stake(alice, float_amount);
        uint256 before = s.circulatingSupply();

        _rebase(profit, 1);

        uint256 grown = s.circulatingSupply() - before;
        assertLe(grown, profit, "never distributes more than the profit");
        assertApproxEqAbs(grown, profit, 2, "and never meaningfully less");
    }

    function testFuzz_transfer_conservesSupply(uint96 amount_) public {
        _stake(alice, 1_000e9);
        uint256 amount = bound(uint256(amount_), 0, 1_000e9);

        vm.prank(alice);
        s.transfer(bob, amount);

        assertEq(s.balanceOf(alice) + s.balanceOf(bob), 1_000e9, "transfers conserve fragments");
    }
}
