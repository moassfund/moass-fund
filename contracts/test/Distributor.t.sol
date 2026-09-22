// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Distributor} from "../src/Distributor.sol";
import {StakedMOASS} from "../src/StakedMOASS.sol";
import {Constants} from "../src/Constants.sol";
import {MockERC20, MockOracle, MockTreasury} from "./mocks/Mocks.sol";

/// @notice Emissions. This is the contract behind the APY the UI prints, so the
///         shape of the curve is pinned here rather than left implicit.
///
/// rate = R_MAX × clamp((premium − 1) / (K − 1), 0, 1)
///
/// with upstream's values: R_MAX = 0.45%/epoch, K = 1.75. Emissions start only
/// above backing, ramp linearly, and cap at 1.75x backing. Two deliberate
/// failure modes are also pinned: a stale oracle mints zero rather than
/// reverting (so the permissionless rebase can never be bricked), and the mint
/// clamps to remaining reserve capacity.
contract DistributorTest is Test {
    Distributor internal distributor;
    StakedMOASS internal sMoass;
    MockERC20 internal moass;
    MockERC20 internal usdg;
    MockTreasury internal treasury;
    MockOracle internal oracle;

    address internal staking;
    address internal alice;

    /// @dev Big enough that the reserve cap never binds unless a test wants it to.
    uint256 internal constant AMPLE_RFV = 1_000_000_000e18;

    function setUp() public {
        staking = makeAddr("staking");
        alice = makeAddr("alice");

        moass = new MockERC20("Moass Fund", "MOASS", 9);
        usdg = new MockERC20("USDG", "USDG", 6);
        sMoass = new StakedMOASS("Staked MOASS", "sMOASS");
        sMoass.wire(staking);

        treasury = new MockTreasury(moass, address(usdg));
        oracle = new MockOracle();
        distributor = new Distributor(
            address(treasury), address(moass), address(sMoass), staking, address(oracle)
        );
        treasury.setMinter(address(distributor), true);

        // A live protocol: 100k MOASS out, someone staked, ample reserves.
        moass.mint(alice, 100_000e9);
        vm.prank(staking);
        sMoass.transfer(alice, 100_000e9);
        treasury.setRfv(AMPLE_RFV);
        treasury.setBackingPerToken(1e18);
    }

    /// @dev Sets the premium by moving the market price against fixed backing.
    function _setPremium(uint256 premiumWad) internal {
        oracle.setTwap(premiumWad); // backing is pinned at 1e18, so twap == premium
    }

    // ── The curve ──

    function test_rate_isZeroAtOrBelowBacking() public {
        _setPremium(1e18);
        assertEq(distributor.currentRateWad(), 0, "no emissions at backing");

        _setPremium(0.8e18);
        assertEq(distributor.currentRateWad(), 0, "no emissions below backing");
    }

    function test_rate_capsAtRMaxAtK() public {
        _setPremium(Constants.K_WAD);
        assertEq(distributor.currentRateWad(), Constants.R_MAX_WAD, "full emissions at K = 1.75x");
    }

    function test_rate_staysCappedAboveK() public {
        _setPremium(10e18);
        assertEq(distributor.currentRateWad(), Constants.R_MAX_WAD, "rate is clamped, not unbounded");
    }

    function test_rate_rampsLinearlyBetweenBackingAndK() public {
        // Halfway from 1.0 to 1.75 is 1.375 → half of R_MAX.
        _setPremium(1.375e18);
        assertApproxEqRel(distributor.currentRateWad(), Constants.R_MAX_WAD / 2, 0.0001e18);

        // A quarter of the way: 1.1875 → a quarter of R_MAX.
        _setPremium(1.1875e18);
        assertApproxEqRel(distributor.currentRateWad(), Constants.R_MAX_WAD / 4, 0.0001e18);
    }

    function test_premium_isPriceOverBacking() public {
        oracle.setTwap(3e18);
        treasury.setBackingPerToken(1.5e18);
        assertEq(distributor.premium(), 2e18, "premium = price / backing");
    }

    function test_premium_isZeroWhenBackingIsZero() public {
        treasury.setBackingPerToken(0);
        assertEq(distributor.premium(), 0);
    }

    /// @dev The headline number: at the cap, 0.45% per 8h epoch compounds to
    ///      roughly 200x over a year. Pinned so nobody "fixes" R_MAX by accident.
    function test_rMaxCompoundsToTheAdvertisedOrderOfMagnitude() public view {
        assertEq(distributor.rMaxWad(), 0.0045e18);
        assertEq(distributor.kWad(), 1.75e18);
        assertEq(Constants.EPOCH_LENGTH, 8 hours, "3 epochs a day");
    }

    // ── nextReward ──

    function test_nextReward_isRateTimesSupply() public {
        _setPremium(Constants.K_WAD); // R_MAX = 0.45%
        // 100k MOASS × 0.45% = 450 MOASS
        assertApproxEqRel(distributor.nextReward(), 450e9, 0.0001e18);
    }

    function test_nextReward_isZeroWithNoStakers() public {
        // Return every fragment to the Staking inventory. The balance is read
        // first: vm.prank applies to the next call, and balanceOf is a call.
        uint256 held = sMoass.balanceOf(alice);
        vm.prank(alice);
        sMoass.transfer(staking, held);

        _setPremium(Constants.K_WAD);
        assertEq(distributor.nextReward(), 0, "nothing minted when nobody is staked");
    }

    // ── D1: a stale oracle must not brick the rebase ──

    function test_staleOracle_mintsZeroRatherThanReverting() public {
        _setPremium(Constants.K_WAD);
        oracle.setStale(true);

        assertEq(distributor.currentRateWad(), 0, "stale TWAP yields a zero rate");
        assertEq(distributor.nextReward(), 0);

        // And the epoch still turns over: distribute() must not revert.
        vm.prank(staking);
        uint256 minted = distributor.distribute();
        assertEq(minted, 0);
        assertEq(distributor.epochsDistributed(), 1, "the epoch still counted");
    }

    function test_staleOracle_premiumItselfStillReverts() public {
        oracle.setStale(true);
        vm.expectRevert();
        distributor.premium();
    }

    // ── D2: the reserve cap clamps the mint ──

    function test_reserveCap_clampsTheMint() public {
        _setPremium(Constants.K_WAD); // wants 450 MOASS

        // Only 100 MOASS of headroom above the current supply.
        // rfv is in 18-decimal terms; supply (9 dec) × 1e9 puts it in the same units.
        uint256 supplyWad = moass.totalSupply() * Constants.MOASS_UNIT;
        treasury.setRfv(supplyWad + 100e18);

        assertEq(distributor.nextReward(), 100e9, "mint is clamped to remaining capacity");
    }

    function test_reserveCap_mintsNothingWhenSupplyMeetsReserves() public {
        _setPremium(Constants.K_WAD);
        treasury.setRfv(moass.totalSupply() * Constants.MOASS_UNIT);

        assertEq(distributor.nextReward(), 0, "at the floor, emissions stop");
    }

    function test_reserveCap_mintsNothingWhenUndercollateralised() public {
        _setPremium(Constants.K_WAD);
        treasury.setRfv(moass.totalSupply() * Constants.MOASS_UNIT / 2);

        assertEq(distributor.nextReward(), 0, "below the floor, emissions stop");
    }

    /// @dev This is the invariant the reserve swap has to preserve or knowingly
    ///      replace: total supply, valued at the 1-unit floor, never exceeds the
    ///      treasury's reported reserves after a mint.
    function test_invariant_supplyNeverOutrunsReserves() public {
        _setPremium(Constants.K_WAD);
        treasury.setRfv(moass.totalSupply() * Constants.MOASS_UNIT + 1_000e18);

        for (uint256 i = 0; i < 20; i++) {
            vm.prank(staking);
            distributor.distribute();
            assertLe(
                moass.totalSupply() * Constants.MOASS_UNIT,
                treasury.rfv(),
                "supply outran the reserves backing it"
            );
        }
    }

    // ── distribute ──

    function test_distribute_onlyStaking() public {
        vm.prank(alice);
        vm.expectRevert(Distributor.NotStaking.selector);
        distributor.distribute();
    }

    function test_distribute_mintsToStaking() public {
        _setPremium(Constants.K_WAD);
        uint256 before = moass.balanceOf(staking);

        vm.prank(staking);
        uint256 minted = distributor.distribute();

        assertApproxEqRel(minted, 450e9, 0.0001e18);
        assertEq(moass.balanceOf(staking) - before, minted, "the reward lands in Staking");
    }

    function test_distribute_countsZeroEpochsToo() public {
        _setPremium(1e18); // rate 0

        vm.prank(staking);
        assertEq(distributor.distribute(), 0);
        assertEq(distributor.epochsDistributed(), 1, "a zero epoch is still an epoch");
    }

    function test_distribute_hasNoOwnerFunctions() public view {
        // Upstream's claim is that this contract has no governance surface at
        // all: every reference is immutable and nothing but distribute() writes.
        assertEq(address(distributor.treasury()), address(treasury));
        assertEq(address(distributor.moass()), address(moass));
        assertEq(distributor.staking(), staking);
        assertEq(address(distributor.oracle()), address(oracle));
    }

    // ── Fuzz ──

    function testFuzz_rate_neverExceedsRMax(uint128 premiumWad) public {
        _setPremium(bound(uint256(premiumWad), 0, 1_000e18));
        assertLe(distributor.currentRateWad(), Constants.R_MAX_WAD, "rate is bounded by R_MAX");
    }

    function testFuzz_rate_isMonotonicInPremium(uint128 a, uint128 b) public {
        uint256 lo = bound(uint256(a), 0, 5e18);
        uint256 hi = bound(uint256(b), lo, 5e18);

        _setPremium(lo);
        uint256 rateLo = distributor.currentRateWad();
        _setPremium(hi);
        uint256 rateHi = distributor.currentRateWad();

        assertGe(rateHi, rateLo, "a higher premium never emits less");
    }
}
