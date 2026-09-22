// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BondDepository} from "../src/BondDepository.sol";
import {Constants} from "../src/Constants.sol";
import {Wired} from "../src/abstract/Wired.sol";
import {MockERC20, MockOracle, MockTreasury, MockPair} from "./mocks/Mocks.sol";

/// @notice Bond markets, pricing, the per-epoch throttle and note vesting.
///
/// Three things here drive the Bond Desk window directly:
///   - price is `max(TWAP × (1 − 3%), backingPerToken)`, so the discount the UI
///     shows floats and can reach zero. It can never go negative.
///   - capacity is per EPOCH (0.25% of supply), not per day. The UI currently
///     says "Left today".
///   - `redeem(to)` claims EVERY ripe note at once. There is no per-note redeem,
///     but the UI offers "Claim selected". See `test_redeem_claimsEveryNote`.
contract BondDepositoryTest is Test {
    BondDepository internal depo;
    MockERC20 internal moass;
    MockERC20 internal usdg;
    MockPair internal pair;
    MockOracle internal oracle;
    MockTreasury internal treasury;

    address internal genesisBond;
    address internal alice;
    address internal bob;

    uint256 internal constant SUPPLY = 1_000_000e9;
    /// @dev 0.25% of supply per 8h epoch.
    uint256 internal constant EPOCH_CAP = SUPPLY * 25 / 10_000;

    function setUp() public {
        genesisBond = makeAddr("genesisBond");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        moass = new MockERC20("Moass Fund", "MOASS", 9);
        usdg = new MockERC20("USDG", "USDG", 6);
        pair = new MockPair(address(moass), address(usdg));
        oracle = new MockOracle();
        treasury = new MockTreasury(moass, address(usdg));

        depo = new BondDepository(
            address(moass), address(usdg), address(pair), address(oracle), address(treasury)
        );
        depo.wire(genesisBond);
        vm.prank(genesisBond);
        depo.enable();

        treasury.setMinter(address(depo), true);

        moass.mint(makeAddr("float"), SUPPLY);
        oracle.setTwap(2e18); // MOASS at $2
        treasury.setBackingPerToken(1e18); // $1 of reserves behind each

        usdg.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usdg.approve(address(depo), type(uint256).max);
    }

    function _bond(address who, uint256 usdgWhole) internal returns (uint256 payout) {
        vm.prank(who);
        (, payout) = depo.deposit(0, usdgWhole * 1e6, type(uint256).max, who);
    }

    // ── Markets ──

    function test_marketCount_isTwo() public view {
        assertEq(depo.marketCount(), 2, "reserve bonds and LP bonds");
        assertEq(depo.quoteToken(0), address(usdg));
        assertEq(depo.quoteToken(1), address(pair));
    }

    function test_quoteToken_revertsOnUnknownMarket() public {
        vm.expectRevert(BondDepository.InvalidMarket.selector);
        depo.quoteToken(2);
    }

    function test_deposit_revertsBeforeEnable() public {
        BondDepository fresh = new BondDepository(
            address(moass), address(usdg), address(pair), address(oracle), address(treasury)
        );
        fresh.wire(genesisBond);

        vm.prank(alice);
        vm.expectRevert(BondDepository.NotEnabled.selector);
        fresh.deposit(0, 1e6, type(uint256).max, alice);
    }

    function test_enable_onlyGenesisBond() public {
        BondDepository fresh = new BondDepository(
            address(moass), address(usdg), address(pair), address(oracle), address(treasury)
        );
        fresh.wire(genesisBond);

        vm.expectRevert(BondDepository.NotGenesisBond.selector);
        fresh.enable();
    }

    function test_wire_isSingleUse() public {
        vm.expectRevert(Wired.AlreadyWired.selector);
        depo.wire(genesisBond);
    }

    // ── Pricing ──

    function test_bondPrice_isTwapLessTheDiscount() public view {
        // $2 × (1 − 3%) = $1.94, which is above the $1 backing floor.
        assertEq(depo.bondPrice(0), 1.94e18);
    }

    function test_bondDiscountIsThreePercent() public view {
        assertEq(Constants.BOND_DISCOUNT_BPS, 300, "3%, not the 8.5% the mock adapter invents");
        assertEq(Constants.BOND_VEST, 2 days, "2 days, not the 5 the UI copy claims");
    }

    /// @dev The NAV floor. Selling below backing would dilute holders, so the
    ///      price never drops under it, however far the market falls.
    function test_bondPrice_neverGoesBelowBacking() public {
        oracle.setTwap(0.5e18); // market well below backing
        assertEq(depo.bondPrice(0), 1e18, "floored at backingPerToken");
    }

    function test_bondPrice_floorMeansTheDiscountCanVanish() public {
        // Market only 1% above backing: the 3% discount would breach the floor.
        oracle.setTwap(1.01e18);
        assertEq(depo.bondPrice(0), 1e18, "priced at backing");

        // So the effective discount the UI would display is under 3%, and the
        // bond is still accretive rather than dilutive.
        assertLt(depo.bondPrice(0), oracle.twapMoassUsdg());
    }

    function test_bondPrice_revertsOnStaleOracle() public {
        oracle.setStale(true);
        vm.expectRevert();
        depo.bondPrice(0);
    }

    // ── Deposit ──

    function test_deposit_paysOutValueOverPrice() public {
        uint256 payout = _bond(alice, 1_000);

        // $1,000 at $1.94 per MOASS.
        assertApproxEqRel(payout, 515.463917e9, 0.0001e18);
    }

    function test_deposit_sendsTheQuoteAssetToTheTreasury() public {
        _bond(alice, 1_000);
        assertEq(usdg.balanceOf(address(treasury)), 1_000e6, "reserves go to the treasury, not the LP");
    }

    function test_deposit_mintsThePayoutToTheDepository() public {
        uint256 before = moass.totalSupply();
        uint256 payout = _bond(alice, 1_000);

        assertEq(moass.totalSupply(), before + payout, "bonding dilutes holders, by design");
        assertEq(moass.balanceOf(address(depo)), payout, "held until it vests");
    }

    function test_deposit_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(BondDepository.ZeroAmount.selector);
        depo.deposit(0, 0, type(uint256).max, alice);
    }

    /// @dev The slippage bound the UI has no way to supply today: `BondDesk.tsx`
    ///      calls bond() with only a market and an amount.
    function test_deposit_respectsMaxPrice() public {
        vm.prank(alice);
        vm.expectRevert(BondDepository.PriceAboveMax.selector);
        depo.deposit(0, 1_000e6, 1.5e18, alice); // price is 1.94
    }

    function test_deposit_succeedsAtExactlyMaxPrice() public {
        vm.prank(alice);
        depo.deposit(0, 1_000e6, 1.94e18, alice);
        assertEq(depo.noteCount(alice), 1);
    }

    function test_deposit_canBeDirectedToAnotherAddress() public {
        vm.prank(alice);
        depo.deposit(0, 1_000e6, type(uint256).max, bob);

        assertEq(depo.noteCount(bob), 1);
        assertEq(depo.noteCount(alice), 0);
    }

    // ── The per-epoch throttle ──

    function test_epochCap_isQuarterPercentOfSupply() public view {
        assertEq(Constants.BOND_EPOCH_CAP_BPS, 25);
        assertEq(EPOCH_CAP, 2_500e9, "0.25% of a 1M supply");
    }

    function test_epochCap_rejectsAnOversizedBond() public {
        // At $1.94, 2,500 MOASS costs ~$4,850. Ask for far more.
        vm.prank(alice);
        vm.expectRevert(BondDepository.EpochCapExceeded.selector);
        depo.deposit(0, 10_000e6, type(uint256).max, alice);
    }

    function test_epochCap_accumulatesAcrossBuyersWithinAnEpoch() public {
        _bond(alice, 2_000); // ~1,030 MOASS
        _bond(alice, 2_000); // ~2,061 cumulative

        // A third of the same size would breach 2,500.
        vm.prank(alice);
        vm.expectRevert(BondDepository.EpochCapExceeded.selector);
        depo.deposit(0, 2_000e6, type(uint256).max, alice);
    }

    /// @dev This is the behaviour the UI mislabels: capacity refills every 8
    ///      hours, not at midnight.
    function test_epochCap_refillsEveryEightHours() public {
        _bond(alice, 4_000);

        vm.prank(alice);
        vm.expectRevert(BondDepository.EpochCapExceeded.selector);
        depo.deposit(0, 4_000e6, type(uint256).max, alice);

        skip(Constants.EPOCH_LENGTH);

        uint256 payout = _bond(alice, 4_000);
        assertGt(payout, 0, "a fresh epoch, a fresh allowance");
    }

    function test_epochCap_tracksPayoutPerEpochIndex() public {
        uint256 payout = _bond(alice, 1_000);
        assertEq(depo.payoutInEpoch(0), payout);

        skip(Constants.EPOCH_LENGTH);
        uint256 second = _bond(alice, 1_000);
        assertEq(depo.payoutInEpoch(1), second);
        assertEq(depo.payoutInEpoch(0), payout, "the previous epoch's usage is untouched");
    }

    // ── Notes and vesting ──

    function test_note_vestsLinearlyOverTwoDays() public {
        uint256 payout = _bond(alice, 1_000);

        (, uint256 claimable) = depo.pendingFor(alice);
        assertEq(claimable, 0, "nothing vested at t=0");

        skip(1 days);
        (, claimable) = depo.pendingFor(alice);
        assertApproxEqRel(claimable, payout / 2, 0.001e18, "half way");

        skip(1 days);
        (, claimable) = depo.pendingFor(alice);
        assertEq(claimable, payout, "fully vested");
    }

    function test_note_doesNotOverVestAfterTheEnd() public {
        uint256 payout = _bond(alice, 1_000);
        skip(30 days);

        (uint256 pending, uint256 claimable) = depo.pendingFor(alice);
        assertEq(claimable, payout);
        assertEq(pending, payout);
    }

    function test_redeem_paysOnlyWhatHasVested() public {
        uint256 payout = _bond(alice, 1_000);
        skip(1 days);

        vm.prank(alice);
        uint256 paid = depo.redeem(alice);

        assertApproxEqRel(paid, payout / 2, 0.001e18);
        assertEq(moass.balanceOf(alice), paid);
    }

    function test_redeem_twiceDoesNotDoublePay() public {
        uint256 payout = _bond(alice, 1_000);
        skip(2 days);

        vm.prank(alice);
        depo.redeem(alice);
        vm.prank(alice);
        uint256 second = depo.redeem(alice);

        assertEq(second, 0, "a claimed note stays claimed");
        assertEq(moass.balanceOf(alice), payout);
    }

    function test_redeem_withNothingVestedIsANoop() public {
        _bond(alice, 1_000);
        vm.prank(alice);
        assertEq(depo.redeem(alice), 0);
    }

    function test_redeem_canBeDirectedElsewhere() public {
        _bond(alice, 1_000);
        skip(2 days);

        vm.prank(alice);
        depo.redeem(bob);

        assertGt(moass.balanceOf(bob), 0);
        assertEq(moass.balanceOf(alice), 0);
    }

    /// @dev `redeem` sweeps every ripe note. The UI's "Claim selected" button,
    ///      which submits a single bond id, cannot be honoured literally — the
    ///      adapter must either claim everything or the button must go.
    function test_redeem_claimsEveryNote() public {
        _bond(alice, 1_000);
        skip(Constants.EPOCH_LENGTH);
        _bond(alice, 1_000);
        skip(2 days);

        assertEq(depo.noteCount(alice), 2);

        vm.prank(alice);
        depo.redeem(alice);

        (, uint256 claimableAfter) = depo.pendingFor(alice);
        assertEq(claimableAfter, 0, "both notes were swept, not just one");
    }

    /// @dev Note indices must stay stable: the Bond Desk holds the selected id
    ///      in component state across its 15-second refetch.
    function test_noteIndicesAreStableAcrossRedemptions() public {
        _bond(alice, 1_000);
        skip(Constants.EPOCH_LENGTH);
        _bond(alice, 2_000);
        skip(2 days);

        (uint256 firstPayout,,,) = depo.notes(alice, 0);
        vm.prank(alice);
        depo.redeem(alice);

        assertEq(depo.noteCount(alice), 2, "fully claimed notes are not removed");
        (uint256 stillFirst, uint256 claimed,,) = depo.notes(alice, 0);
        assertEq(stillFirst, firstPayout, "index 0 is still the same note");
        assertEq(claimed, firstPayout, "it is just marked claimed");
    }

    function test_pendingFor_reportsBothTotals() public {
        uint256 payout = _bond(alice, 1_000);
        skip(1 days);

        (uint256 pending, uint256 claimable) = depo.pendingFor(alice);
        assertEq(pending, payout, "total still owed");
        assertApproxEqRel(claimable, payout / 2, 0.001e18, "of which claimable now");
    }

    // ── LP bonds ──

    function test_lpBond_valuesLpAtIntrinsicNotMarket() public {
        // Pool: 1,000 MOASS and 4,000 USDG, so MOASS trades at $4.
        bool moassFirst = address(moass) < address(usdg);
        pair.setReserves(
            moassFirst ? uint112(1_000e9) : uint112(4_000e6),
            moassFirst ? uint112(4_000e6) : uint112(1_000e9)
        );
        pair.mintLp(alice, 100e18);
        pair.mintLp(address(0xdead), 0); // totalSupply stays 100e18

        vm.startPrank(alice);
        pair.approve(address(depo), type(uint256).max);
        (, uint256 payout) = depo.deposit(1, 100e18, type(uint256).max, alice);
        vm.stopPrank();

        // LP RFV is 2·√(4000 × 1000) = $4,000 for the whole pool, and alice owns
        // all of it. At the $1.94 bond price that is ~2,061 MOASS.
        assertApproxEqRel(payout, 2_061.855e9, 0.001e18);
    }

    function test_lpBond_sendsLpToTheTreasury() public {
        bool moassFirst = address(moass) < address(usdg);
        pair.setReserves(
            moassFirst ? uint112(1_000e9) : uint112(1_000e6),
            moassFirst ? uint112(1_000e6) : uint112(1_000e9)
        );
        pair.mintLp(alice, 100e18);

        vm.startPrank(alice);
        pair.approve(address(depo), type(uint256).max);
        depo.deposit(1, 50e18, type(uint256).max, alice);
        vm.stopPrank();

        assertEq(pair.balanceOf(address(treasury)), 50e18, "protocol-owned liquidity");
    }

    // ── Fuzz ──

    function testFuzz_payoutIsAlwaysValueOverPrice(uint64 usdgRaw) public {
        // Bounded below the epoch cap so the throttle is not what is tested.
        uint256 amount = bound(uint256(usdgRaw), 1e6, 4_000e6);

        uint256 price = depo.bondPrice(0);
        vm.prank(alice);
        (, uint256 payout) = depo.deposit(0, amount, type(uint256).max, alice);

        assertEq(payout, amount * 1e12 * Constants.MOASS_UNIT / price);
    }

    function testFuzz_bondPriceNeverUndercutsBacking(uint128 twap, uint128 backing) public {
        uint256 t = bound(uint256(twap), 1, 1_000e18);
        uint256 b = bound(uint256(backing), 1, 1_000e18);
        oracle.setTwap(t);
        treasury.setBackingPerToken(b);

        assertGe(depo.bondPrice(0), b, "a bond can never be sold below backing");
    }
}
