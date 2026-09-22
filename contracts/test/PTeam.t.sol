// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PTeam} from "../src/PTeam.sol";
import {Constants} from "../src/Constants.sol";
import {Wired} from "../src/abstract/Wired.sol";
import {MockERC20, MockTreasury, MockGenesisBond} from "./mocks/Mocks.sol";

/// @notice The team allocation, and the clock that also drives the tax split.
///
/// pTEAM is an option, not a grant: the team must pay $1 per MOASS into the
/// treasury to exercise. Because the strike equals the backing floor, exercising
/// never dilutes backing — it dilutes the premium only. Rights vest linearly
/// over 30 days and are capped at 15% of the circulating float.
///
/// `vestedFraction()` is also what decays the tax split in TaxCollector, so the
/// two are one clock rather than two settings that could disagree.
contract PTeamTest is Test {
    PTeam internal pTeam;
    MockERC20 internal moass;
    MockERC20 internal usdg;
    MockTreasury internal treasury;
    MockGenesisBond internal genesis;

    address internal holder;
    address internal alice;
    address internal excludedHolder;

    function setUp() public {
        vm.warp(1_800_000_000);
        holder = makeAddr("teamMultisig");
        alice = makeAddr("alice");
        excludedHolder = makeAddr("bondDepository");

        moass = new MockERC20("Moass Fund", "MOASS", 9);
        usdg = new MockERC20("USDG", "USDG", 6);
        treasury = new MockTreasury(moass, address(usdg));
        genesis = new MockGenesisBond();

        pTeam = new PTeam(address(moass), address(usdg), address(treasury), holder);

        address[] memory excluded = new address[](1);
        excluded[0] = excludedHolder;
        pTeam.wire(address(genesis), excluded);

        treasury.setMinter(address(pTeam), true);

        moass.mint(alice, 100_000e9);
        usdg.mint(holder, 1_000_000e6);
        vm.prank(holder);
        usdg.approve(address(pTeam), type(uint256).max);
    }

    function _launch() internal {
        genesis.setFinalizeTime(uint64(block.timestamp));
    }

    // ── Parameters ──

    function test_parameters() public view {
        assertEq(pTeam.strikeWad(), 1e18, "strike is exactly the $1 backing floor");
        assertEq(pTeam.capBps(), 1_500, "15% of float");
        assertEq(Constants.VEST_DURATION, 30 days);
        assertEq(pTeam.holder(), holder, "single holder, the team multisig");
    }

    // ── The vesting clock ──

    function test_vestedFraction_isZeroBeforeLaunch() public view {
        assertEq(pTeam.vestedFraction(), 0);
        assertEq(pTeam.exercisableNow(), 0);
    }

    function test_vestedFraction_rampsLinearlyOverThirtyDays() public {
        _launch();
        assertEq(pTeam.vestedFraction(), 0, "nothing at t=0");

        skip(15 days);
        assertApproxEqRel(pTeam.vestedFraction(), 0.5e18, 0.0001e18, "half way");

        skip(15 days);
        assertEq(pTeam.vestedFraction(), 1e18, "fully vested");
    }

    function test_vestedFraction_clampsAtOne() public {
        _launch();
        skip(365 days);
        assertEq(pTeam.vestedFraction(), 1e18, "never exceeds 1.0");
    }

    function test_vestedFraction_isZeroWhileUnwired() public {
        // A fresh, unwired pTEAM reports zero rather than reverting, so the tax
        // split it feeds has a safe default.
        PTeam fresh = new PTeam(address(moass), address(usdg), address(treasury), holder);
        assertEq(fresh.vestedFraction(), 0);
    }

    // ── The float ──

    function test_circulatingSupply_excludesProtocolHeldMoass() public {
        moass.mint(excludedHolder, 50_000e9);

        assertEq(moass.totalSupply(), 150_000e9);
        assertEq(pTeam.circulatingSupply(), 100_000e9, "protocol-held MOASS is not float");
    }

    function test_excludedFromFloat_isFixedAtWiring() public view {
        address[] memory list = pTeam.excludedFromFloat();
        assertEq(list.length, 1);
        assertEq(list[0], excludedHolder);
    }

    function test_wire_isSingleUse() public {
        address[] memory more = new address[](1);
        more[0] = alice;
        vm.expectRevert(Wired.AlreadyWired.selector);
        pTeam.wire(address(genesis), more);
    }

    // ── Exercising ──

    function test_exercise_onlyHolder() public {
        _launch();
        skip(30 days);

        vm.prank(alice);
        vm.expectRevert(PTeam.NotHolder.selector);
        pTeam.exercise(1e9);
    }

    function test_exercise_paysTheStrikeIntoTheTreasury() public {
        _launch();
        skip(30 days);

        vm.prank(holder);
        pTeam.exercise(1_000e9);

        assertEq(usdg.balanceOf(address(treasury)), 1_000e6, "$1 per MOASS, into reserves");
        assertEq(moass.balanceOf(holder), 1_000e9);
    }

    /// @dev The reason the strike is set at the floor: exercising adds exactly
    ///      as much backing as it adds supply, so backing per token is
    ///      unchanged. The team dilutes the premium, never the floor.
    function test_exercise_doesNotDiluteBacking() public {
        _launch();
        skip(30 days);

        // Start at exactly $1 of backing per MOASS.
        usdg.mint(address(treasury), 100_000e6);
        uint256 backingBefore = usdg.balanceOf(address(treasury)) * 1e12 * 1e9 / moass.totalSupply();

        vm.prank(holder);
        pTeam.exercise(1_000e9);

        uint256 backingAfter = usdg.balanceOf(address(treasury)) * 1e12 * 1e9 / moass.totalSupply();
        assertEq(backingAfter, backingBefore, "backing per token is untouched by an exercise");
    }

    function test_exercise_revertsBeforeAnythingHasVested() public {
        _launch();

        vm.prank(holder);
        vm.expectRevert(PTeam.ExceedsVestedCap.selector);
        pTeam.exercise(1e9);
    }

    function test_exercise_isCappedByTheVestedFraction() public {
        _launch();
        skip(15 days); // 50% vested

        // 50% × 15% × 100,000 float = 7,500 MOASS.
        assertApproxEqRel(pTeam.exercisableNow(), 7_500e9, 0.001e18);

        vm.prank(holder);
        vm.expectRevert(PTeam.ExceedsVestedCap.selector);
        pTeam.exercise(8_000e9);
    }

    function test_exercise_fullVestCapsAtFifteenPercentOfFloat() public {
        _launch();
        skip(30 days);

        assertEq(pTeam.exercisableNow(), 15_000e9, "15% of the 100,000 float");
    }

    function test_exercise_drawsDownTheAllowance() public {
        _launch();
        skip(30 days);

        vm.prank(holder);
        pTeam.exercise(5_000e9);

        assertEq(pTeam.exercised(), 5_000e9);
        // The float grew by the minted 5,000, so the cap moved with it:
        // 15% of 105,000 = 15,750, less the 5,000 already taken.
        assertEq(pTeam.exercisableNow(), 15_750e9 - 5_000e9);
    }

    /// @dev Worth stating plainly, because "15% cap" undersells it: the MOASS an
    ///      exercise mints goes to the team wallet, which is NOT on the float
    ///      exclusion list, so every exercise enlarges the float the cap is
    ///      measured against. Repeated exercising converges on
    ///      `0.15 / 0.85 = 17.65%` of the original float rather than 15%.
    ///      It does terminate — it is a geometric series, not a loophole.
    function test_repeatedExerciseConvergesAboveTheHeadlineCap() public {
        _launch();
        skip(30 days);
        uint256 floatBefore = pTeam.circulatingSupply();

        vm.startPrank(holder);
        for (uint256 i = 0; i < 40; i++) {
            uint256 remaining = pTeam.exercisableNow();
            if (remaining == 0) break;
            pTeam.exercise(remaining);
        }

        vm.expectRevert(PTeam.ExceedsVestedCap.selector);
        pTeam.exercise(1e9);
        vm.stopPrank();

        // 0.15 / 0.85 of the original 100,000 float.
        assertApproxEqRel(pTeam.exercised(), floatBefore * 1_500 / 8_500, 0.0001e18);
        assertApproxEqRel(pTeam.exercised(), 17_647e9, 0.001e18);
    }

    function test_exercise_revertsBeforeWiring() public {
        PTeam fresh = new PTeam(address(moass), address(usdg), address(treasury), holder);
        vm.prank(holder);
        vm.expectRevert(Wired.NotWired.selector);
        fresh.exercise(1e9);
    }

    // ── Fuzz ──

    function testFuzz_vestedFractionIsMonotonic(uint32 a, uint32 b) public {
        _launch();
        uint256 first = bound(uint256(a), 0, 60 days);
        uint256 second = bound(uint256(b), first, 60 days);

        skip(first);
        uint256 v1 = pTeam.vestedFraction();
        skip(second - first);
        uint256 v2 = pTeam.vestedFraction();

        assertGe(v2, v1, "vesting never runs backwards");
        assertLe(v2, Constants.WAD);
    }

    function testFuzz_exerciseNeverExceedsTheCap(uint64 amount_) public {
        _launch();
        skip(30 days);
        uint256 cap = pTeam.exercisableNow();
        uint256 amount = bound(uint256(amount_), 1e9, cap * 2);

        vm.prank(holder);
        if (amount > cap) {
            vm.expectRevert(PTeam.ExceedsVestedCap.selector);
            pTeam.exercise(amount);
        } else {
            pTeam.exercise(amount);
            assertLe(pTeam.exercised(), cap);
        }
    }
}
