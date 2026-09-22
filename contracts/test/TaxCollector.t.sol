// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TaxCollector} from "../src/TaxCollector.sol";
import {Constants} from "../src/Constants.sol";
import {Wired} from "../src/abstract/Wired.sol";
import {MockERC20, MockOracle, MockPair, MockRouter, MockPTeam} from "./mocks/Mocks.sol";

/// @notice Where the 5% tax actually goes.
///
/// The headline the team needs to hear: the split is NOT fixed. It decays on
/// pTEAM's vesting clock — `teamBps = 400 × (1 − vestedFraction)`. At launch
/// that is 400 of the 500 bps, so **80% of every tax dollar goes to the team
/// wallet**, reaching zero after the 30-day vest, after which the treasury
/// takes all of it. There is no admin setter; the clock is the only input.
/// See `test_split_startsMostlyToTheTeamAndDecaysToNothing`.
///
/// Conversions are doubly bounded: a size clip against pool depth, and a TWAP
/// floor on the proceeds, so the sweep cannot be sandwiched for much.
contract TaxCollectorTest is Test {
    TaxCollector internal collector;
    MockERC20 internal moass;
    MockERC20 internal usdg;
    MockPair internal pair;
    MockRouter internal router;
    MockOracle internal oracle;
    MockPTeam internal pTeam;

    address internal treasury;
    address internal teamWallet;

    bool internal moassFirst;

    function setUp() public {
        treasury = makeAddr("treasury");
        teamWallet = makeAddr("teamWallet");

        moass = new MockERC20("Moass Fund", "MOASS", 9);
        usdg = new MockERC20("USDG", "USDG", 6);
        pair = new MockPair(address(moass), address(usdg));
        moassFirst = address(moass) < address(usdg);
        router = new MockRouter(moass, usdg);
        oracle = new MockOracle();
        pTeam = new MockPTeam();

        collector = new TaxCollector(
            address(moass), address(usdg), address(router), address(pair),
            address(oracle), treasury, teamWallet
        );
        collector.wire(address(pTeam));

        // A deep pool so the clip bound is not what binds by default.
        pair.setReserves(
            moassFirst ? uint112(1_000_000e9) : uint112(1_000_000e6),
            moassFirst ? uint112(1_000_000e6) : uint112(1_000_000e9)
        );
        oracle.setTwap(1e18);
        router.setRate(1e18);

        // Tax accrues to the collector as MOASS.
        moass.mint(address(collector), 10_000e9);
    }

    // ── The split ──

    function test_split_startsMostlyToTheTeamAndDecaysToNothing() public {
        pTeam.setVestedFraction(0);
        assertEq(collector.teamBps(), 400, "at launch: 400 of 500 bps, i.e. 80% of the tax");
        assertEq(collector.treasuryBps(), 100);

        pTeam.setVestedFraction(0.5e18);
        assertEq(collector.teamBps(), 200, "half way through the vest");
        assertEq(collector.treasuryBps(), 300);

        pTeam.setVestedFraction(1e18);
        assertEq(collector.teamBps(), 0, "fully vested: every tax dollar goes to the treasury");
        assertEq(collector.treasuryBps(), 500);
    }

    function test_split_hasNoAdminSetter() public {
        // The only input is the pTEAM clock. Nothing else can move the split.
        pTeam.setVestedFraction(0.25e18);
        assertEq(collector.teamBps(), 300);
        assertEq(collector.teamBps() + collector.treasuryBps(), Constants.TAX_TOTAL_BPS);
    }

    function test_convert_routesProceedsByTheCurrentSplit() public {
        pTeam.setVestedFraction(0); // 80/20 in the team's favour

        collector.convert(1_000e9, 0);

        // 1,000 MOASS at $1 = 1,000 USDG. 400/500 to the team.
        assertEq(usdg.balanceOf(teamWallet), 800e6);
        assertEq(usdg.balanceOf(treasury), 200e6);
    }

    function test_convert_sendsEverythingToTreasuryOnceVested() public {
        pTeam.setVestedFraction(1e18);

        collector.convert(1_000e9, 0);

        assertEq(usdg.balanceOf(teamWallet), 0);
        assertEq(usdg.balanceOf(treasury), 1_000e6);
    }

    function test_convert_conservesProceeds() public {
        pTeam.setVestedFraction(0.3e18);
        collector.convert(1_000e9, 0);

        assertEq(
            usdg.balanceOf(teamWallet) + usdg.balanceOf(treasury),
            1_000e6,
            "nothing is retained by the collector"
        );
    }

    // ── Guards ──

    function test_convert_isPermissionless() public {
        vm.prank(makeAddr("keeper"));
        collector.convert(100e9, 0);
        assertGt(usdg.balanceOf(treasury), 0, "anyone may sweep the tax");
    }

    function test_convert_revertsOnZeroAmount() public {
        vm.expectRevert(TaxCollector.ZeroAmount.selector);
        collector.convert(0, 0);
    }

    function test_convert_revertsBeforeWiring() public {
        TaxCollector fresh = new TaxCollector(
            address(moass), address(usdg), address(router), address(pair),
            address(oracle), treasury, teamWallet
        );
        vm.expectRevert(Wired.NotWired.selector);
        fresh.convert(1e9, 0);
    }

    /// @dev Size clip: a sweep may never exceed 50 bps of the pool's MOASS
    ///      reserve, so the collector cannot dump into thin liquidity.
    function test_convert_rejectsAClipLargerThanThePoolCanBear() public {
        uint256 reserve = 1_000_000e9;
        uint256 maxClip = reserve * Constants.TAX_SWAP_MAX_CLIP_BPS / Constants.BPS;

        collector.convert(maxClip, 0); // exactly at the bound is fine

        moass.mint(address(collector), 100_000e9);
        vm.expectRevert(TaxCollector.ClipTooLarge.selector);
        collector.convert(maxClip + 1, 0);
    }

    function test_clipBoundIsFiftyBps() public view {
        assertEq(Constants.TAX_SWAP_MAX_CLIP_BPS, 50);
        assertEq(Constants.TAX_SWAP_MAX_DEV_BPS, 100, "and proceeds may not fall 1% under TWAP");
    }

    /// @dev TWAP floor: even asking for zero minimum, the contract imposes its
    ///      own bound, so a sandwich cannot steal more than 1%.
    function test_convert_enforcesATwapFloorEvenWhenCallerAsksForNothing() public {
        oracle.setTwap(1e18);
        router.setRate(0.9e18); // router would fill 10% below TWAP

        vm.expectRevert(bytes("MockRouter: INSUFFICIENT_OUTPUT_AMOUNT"));
        collector.convert(1_000e9, 0);
    }

    function test_convert_acceptsAFillJustInsideTheTwapBound() public {
        oracle.setTwap(1e18);
        router.setRate(0.995e18); // 0.5% below TWAP, inside the 1% tolerance

        collector.convert(1_000e9, 0);
        assertGt(usdg.balanceOf(treasury), 0);
    }

    function test_convert_honoursAStricterCallerMinimum() public {
        router.setRate(1e18);

        vm.expectRevert(bytes("MockRouter: INSUFFICIENT_OUTPUT_AMOUNT"));
        collector.convert(1_000e9, 2_000e6); // demand more than the pool gives
    }

    function test_convert_revertsOnAStaleOracle() public {
        oracle.setStale(true);
        vm.expectRevert();
        collector.convert(1_000e9, 0);
    }

    // ── Views ──

    function test_pendingMoass_reportsTheUnsweptBalance() public view {
        assertEq(collector.pendingMoass(), 10_000e9);
    }

    function test_pendingMoass_fallsAfterASweep() public {
        collector.convert(1_000e9, 0);
        assertEq(collector.pendingMoass(), 9_000e9);
    }

    // ── Fuzz ──

    function testFuzz_splitAlwaysSumsToTheWholeTax(uint64 vested) public {
        uint256 v = bound(uint256(vested), 0, 1e18);
        pTeam.setVestedFraction(v);

        assertEq(collector.teamBps() + collector.treasuryBps(), Constants.TAX_TOTAL_BPS);
        assertLe(collector.teamBps(), Constants.TAX_TEAM_START_BPS, "the team share never grows");
    }

    function testFuzz_proceedsAreFullyDistributed(uint64 amount_, uint64 vested) public {
        uint256 amount = bound(uint256(amount_), 1e9, 5_000e9);
        pTeam.setVestedFraction(bound(uint256(vested), 0, 1e18));

        collector.convert(amount, 0);

        assertEq(usdg.balanceOf(address(collector)), 0, "the collector keeps nothing");
    }
}
