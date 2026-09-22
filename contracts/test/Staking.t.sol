// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Staking} from "../src/Staking.sol";
import {StakedMOASS} from "../src/StakedMOASS.sol";
import {Constants} from "../src/Constants.sol";
import {Wired} from "../src/abstract/Wired.sol";
import {MockERC20, MockDistributor, MockOracle} from "./mocks/Mocks.sol";

/// @notice Staking: the MOASS ⇄ sMOASS door and the 8h epoch clock.
///
/// The solvency property is that Staking always holds at least as much MOASS as
/// there is circulating sMOASS — every fragment a user holds must be redeemable.
/// It is asserted after every state-changing test via `_assertSolvent`.
contract StakingTest is Test {
    Staking internal staking;
    StakedMOASS internal sMoass;
    MockERC20 internal moass;
    MockDistributor internal distributor;
    MockOracle internal oracle;

    address internal genesisBond;
    address internal alice;
    address internal bob;

    uint256 internal constant EPOCH = 8 hours;

    function setUp() public {
        genesisBond = makeAddr("genesisBond");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        moass = new MockERC20("Moass Fund", "MOASS", 9);
        sMoass = new StakedMOASS();
        staking = new Staking(address(moass), address(sMoass), Constants.STAKING_WARMUP_EPOCHS);

        distributor = new MockDistributor(moass, address(staking));
        oracle = new MockOracle();

        sMoass.wire(address(staking));
        staking.wire(address(distributor), address(oracle), genesisBond);

        vm.prank(genesisBond);
        staking.enable();

        moass.mint(alice, 10_000e9);
        moass.mint(bob, 10_000e9);
        vm.prank(alice);
        moass.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        moass.approve(address(staking), type(uint256).max);
    }

    /// @dev Every circulating sMOASS fragment must be backed by MOASS sitting in
    ///      the Staking contract, or somebody cannot unstake.
    function _assertSolvent() internal view {
        assertGe(
            moass.balanceOf(address(staking)),
            sMoass.circulatingSupply(),
            "Staking holds less MOASS than there is circulating sMOASS"
        );
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        staking.stake(who, amount);
    }

    function _epochNumber() internal view returns (uint64 n) {
        (, n,,) = staking.epoch();
    }

    function _epochEnd() internal view returns (uint64 e) {
        (,, e,) = staking.epoch();
    }

    function _queued() internal view returns (uint256 d) {
        (,,, d) = staking.epoch();
    }

    // ── Enable ──

    function test_enable_setsEightHourEpoch() public view {
        (uint64 length, uint64 number, uint64 end,) = staking.epoch();
        assertEq(length, EPOCH, "8 hour epochs, matching EPOCH_HOURS in the front end config");
        assertEq(number, 1);
        assertEq(end, block.timestamp + EPOCH);
        assertTrue(staking.enabled());
    }

    function test_enable_onlyGenesisBond() public {
        Staking fresh = new Staking(address(moass), address(sMoass), 0);
        fresh.wire(address(distributor), address(oracle), genesisBond);

        vm.expectRevert(Staking.NotGenesisBond.selector);
        fresh.enable();
    }

    function test_enable_revertsTwice() public {
        vm.prank(genesisBond);
        vm.expectRevert(Staking.AlreadyEnabled.selector);
        staking.enable();
    }

    function test_enable_revertsBeforeWiring() public {
        Staking fresh = new Staking(address(moass), address(sMoass), 0);
        vm.prank(genesisBond);
        vm.expectRevert(Wired.NotWired.selector);
        fresh.enable();
    }

    function test_wire_revertsTwice() public {
        vm.expectRevert(Wired.AlreadyWired.selector);
        staking.wire(address(distributor), address(oracle), genesisBond);
    }

    function test_wire_revertsForNonDeployer() public {
        Staking fresh = new Staking(address(moass), address(sMoass), 0);
        vm.prank(alice);
        vm.expectRevert(Wired.NotDeployer.selector);
        fresh.wire(address(distributor), address(oracle), genesisBond);
    }

    function test_stake_revertsWhenNotEnabled() public {
        Staking fresh = new Staking(address(moass), address(sMoass), 0);
        fresh.wire(address(distributor), address(oracle), genesisBond);

        vm.prank(alice);
        vm.expectRevert(Staking.NotEnabled.selector);
        fresh.stake(alice, 1e9);
    }

    // ── Stake / unstake, warmup 0 ──

    function test_stake_isOneToOneAndImmediate() public {
        _stake(alice, 1_000e9);

        assertEq(sMoass.balanceOf(alice), 1_000e9, "1:1, no fee, no lockup");
        assertEq(moass.balanceOf(alice), 9_000e9);
        assertEq(staking.totalStaked(), 1_000e9);
        _assertSolvent();
    }

    function test_unstake_returnsMoassOneToOne() public {
        _stake(alice, 1_000e9);

        vm.startPrank(alice);
        sMoass.approve(address(staking), type(uint256).max);
        staking.unstake(alice, 400e9);
        vm.stopPrank();

        assertEq(sMoass.balanceOf(alice), 600e9);
        assertEq(moass.balanceOf(alice), 9_400e9);
        _assertSolvent();
    }

    function test_stake_onBehalfOfAnotherAddressWhenWarmupIsZero() public {
        vm.prank(alice);
        staking.stake(bob, 500e9);

        assertEq(sMoass.balanceOf(bob), 500e9, "third-party staking is allowed with no warmup");
        _assertSolvent();
    }

    function test_claim_isNoopWhenWarmupIsZero() public {
        _stake(alice, 1_000e9);
        vm.prank(alice);
        assertEq(staking.claim(alice), 0);
    }

    // ── Warmup, when enabled ──

    function test_warmup_holdsBackFragmentsUntilRelease() public {
        (Staking warm,) = _deployWithWarmup(2);

        vm.prank(alice);
        warm.stake(alice, 1_000e9);

        assertEq(sMoass.balanceOf(alice), 0, "nothing lands until warmup clears");

        _advanceEpochs(warm, 2);

        vm.prank(alice);
        uint256 claimed = warm.claim(alice);
        assertEq(claimed, 1_000e9);
        assertEq(sMoass.balanceOf(alice), 1_000e9);
    }

    function test_warmup_claimBeforeReleaseReturnsZero() public {
        (Staking warm,) = _deployWithWarmup(2);

        vm.prank(alice);
        warm.stake(alice, 1_000e9);

        vm.prank(alice);
        assertEq(warm.claim(alice), 0, "cannot claim early");
    }

    function test_warmup_rejectsThirdPartyStake() public {
        (Staking warm,) = _deployWithWarmup(2);

        // Upstream guards this: a dust stake from a stranger would otherwise
        // keep re-arming someone else's warmup clock forever.
        vm.prank(alice);
        vm.expectRevert(Staking.ThirdPartyWarmup.selector);
        warm.stake(bob, 1e9);
    }

    // ── Epoch clock ──

    function test_rebase_doesNothingBeforeEpochEnd() public {
        _stake(alice, 1_000e9);
        uint64 number = _epochNumber();

        skip(EPOCH - 1);
        staking.rebase();

        assertEq(_epochNumber(), number, "epoch does not advance early");
    }

    function test_rebase_advancesOneEpochAndQueuesTheNextMint() public {
        _stake(alice, 1_000e9);
        distributor.setPerEpoch(5e9);

        skip(EPOCH);
        staking.rebase();

        assertEq(_epochNumber(), 2);
        assertEq(_queued(), 5e9, "next epoch's reward is queued, not paid yet");
        assertEq(sMoass.balanceOf(alice), 1_000e9, "first rebase pays nothing: nothing was queued");
        _assertSolvent();
    }

    function test_rebase_paysTheQueuedRewardOnTheFollowingEpoch() public {
        _stake(alice, 1_000e9);
        distributor.setPerEpoch(5e9);

        skip(EPOCH);
        staking.rebase(); // queues 5
        skip(EPOCH);
        staking.rebase(); // pays 5, queues another 5

        assertApproxEqAbs(sMoass.balanceOf(alice), 1_005e9, 2, "the queued reward lands");
        _assertSolvent();
    }

    function test_rebase_keepsOracleAliveEveryEpoch() public {
        _stake(alice, 1_000e9);
        uint256 before = oracle.checkpoints();

        skip(EPOCH);
        staking.rebase();

        assertEq(oracle.checkpoints(), before + 1, "rebase checkpoints the oracle");
    }

    function test_rebase_isPermissionless() public {
        _stake(alice, 1_000e9);
        skip(EPOCH);

        vm.prank(makeAddr("randomKeeper"));
        staking.rebase();

        assertEq(_epochNumber(), 2, "anyone may turn the crank");
    }

    function test_rebase_missedEpochsCatchUpOneCallAtATime() public {
        _stake(alice, 1_000e9);
        distributor.setPerEpoch(5e9);

        // Nobody calls rebase for a day (three 8h epochs).
        skip(3 * EPOCH);

        staking.rebase();
        assertEq(_epochNumber(), 2, "one epoch per call, by design");
        staking.rebase();
        assertEq(_epochNumber(), 3);
        staking.rebase();
        assertEq(_epochNumber(), 4);

        // Clock is realigned rather than drifting forward from "now".
        assertEq(_epochEnd(), 4 * EPOCH + uint64(block.timestamp) - 3 * uint64(EPOCH));
        _assertSolvent();
    }

    function test_rebase_withNoStakersQueuesRatherThanStranding() public {
        distributor.setPerEpoch(5e9);

        skip(EPOCH);
        staking.rebase();
        skip(EPOCH);
        staking.rebase();

        // Nothing circulates, so nothing was paid out, and the reward stays
        // queued for whoever stakes next rather than vanishing into inventory.
        assertEq(sMoass.circulatingSupply(), 0);
        assertEq(_queued(), 10e9, "two epochs of rewards still queued");
    }

    function test_stakeTriggersDueRebase() public {
        _stake(alice, 1_000e9);
        distributor.setPerEpoch(5e9);

        skip(EPOCH);
        _stake(bob, 1_000e9); // stake() calls _rebaseIfDue() first

        assertEq(_epochNumber(), 2, "staking turns the crank too");
        _assertSolvent();
    }

    function test_unstakeTriggersDueRebase() public {
        _stake(alice, 1_000e9);
        distributor.setPerEpoch(5e9);
        skip(EPOCH);
        staking.rebase(); // queue 5
        skip(EPOCH);

        vm.startPrank(alice);
        sMoass.approve(address(staking), type(uint256).max);
        staking.unstake(alice, 100e9);
        vm.stopPrank();

        assertEq(_epochNumber(), 3);
        // Alice earned the rebase before her withdrawal was processed.
        assertApproxEqAbs(sMoass.balanceOf(alice), 905e9, 2);
        _assertSolvent();
    }

    /// @dev A rebase that pays out more than Staking holds would leave the last
    ///      unstaker short. The distributor mints to Staking first, so this
    ///      should hold across a long run of epochs.
    function test_solvencyHoldsAcrossManyEpochs() public {
        _stake(alice, 1_000e9);
        _stake(bob, 3_000e9);

        for (uint256 i = 0; i < 20; i++) {
            distributor.setPerEpoch(sMoass.circulatingSupply() * 45 / 10_000);
            skip(EPOCH);
            staking.rebase();
            _assertSolvent();
        }

        // Everyone can still get out.
        vm.startPrank(alice);
        sMoass.approve(address(staking), type(uint256).max);
        staking.unstake(alice, sMoass.balanceOf(alice));
        vm.stopPrank();

        vm.startPrank(bob);
        sMoass.approve(address(staking), type(uint256).max);
        staking.unstake(bob, sMoass.balanceOf(bob));
        vm.stopPrank();

        assertGt(moass.balanceOf(alice), 10_000e9, "alice withdrew more than she put in");
        assertGt(moass.balanceOf(bob), 10_000e9);
    }

    // ── Helpers ──

    function _deployWithWarmup(uint256 epochs) internal returns (Staking warm, StakedMOASS s) {
        s = new StakedMOASS();
        warm = new Staking(address(moass), address(s), epochs);
        MockDistributor d = new MockDistributor(moass, address(warm));
        s.wire(address(warm));
        warm.wire(address(d), address(oracle), genesisBond);
        vm.prank(genesisBond);
        warm.enable();

        vm.prank(alice);
        moass.approve(address(warm), type(uint256).max);

        // The warmup suite reads balances off the shared sMoass handle.
        sMoass = s;
    }

    function _advanceEpochs(Staking s, uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            skip(EPOCH);
            s.rebase();
        }
    }
}
