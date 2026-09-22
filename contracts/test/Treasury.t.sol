// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../src/Treasury.sol";
import {Constants} from "../src/Constants.sol";
import {Wired} from "../src/abstract/Wired.sol";
import {MockERC20, MockERC4626, MockPair} from "./mocks/Mocks.sol";

/// @notice Treasury valuation and authority.
///
/// This is the contract the reserve swap will change most, so the current
/// behaviour is pinned precisely. Two properties matter above the rest:
///
///   1. `rfv()` is denominated in "WAD reserve units", and the whole protocol
///      treats ONE reserve unit as the floor price of one MOASS. With a
///      stablecoin that floor is $1 and never moves. Swapping the reserve to
///      GME makes the floor one GME (~$23 today) and makes it move — see
///      `test_reserveUnit_isTheImplicitFloorPrice` at the bottom.
///   2. Minting is restricted to a fixed set wired once at deploy. There is no
///      function that can add a minter later.
contract TreasuryTest is Test {
    Treasury internal treasury;
    MockERC20 internal moass;
    MockERC20 internal usdg;
    MockERC4626 internal vault;
    MockPair internal pair;

    address internal minter;
    address internal spender;
    address internal alice;

    /// @dev 10^(18 − 6): raw USDG → WAD, mirroring the treasury's own factor.
    uint256 internal constant USDG_WAD = 1e12;

    function setUp() public {
        minter = makeAddr("minter");
        spender = makeAddr("spender");
        alice = makeAddr("alice");

        moass = new MockERC20("Moass Fund", "MOASS", 9);
        usdg = new MockERC20("USDG", "USDG", 6);
        vault = new MockERC4626(usdg);
        pair = new MockPair(address(moass), address(usdg));

        treasury = new Treasury(address(moass), address(usdg), address(vault), address(pair));

        address[] memory minters = new address[](1);
        minters[0] = minter;
        address[] memory spenders = new address[](1);
        spenders[0] = spender;
        treasury.wire(minters, spenders);
    }

    function _fundUsdg(uint256 whole) internal {
        usdg.mint(address(treasury), whole * 1e6);
    }

    // ── Valuation ──

    function test_liquidUsdg_scalesSixDecimalsToWad() public {
        _fundUsdg(1_000);
        assertEq(treasury.liquidUsdg(), 1_000e18, "6-decimal USDG is reported in 18-decimal WAD");
    }

    function test_rfv_isLiquidWhenNothingElseIsHeld() public {
        _fundUsdg(5_000);
        assertEq(treasury.rfv(), 5_000e18);
    }

    function test_backingPerToken_isRfvOverSupply() public {
        _fundUsdg(10_000);
        moass.mint(alice, 5_000e9); // 5,000 MOASS against $10,000

        assertEq(treasury.backingPerToken(), 2e18, "$2 of reserves per MOASS");
    }

    function test_backingPerToken_isZeroWithNoSupply() public {
        _fundUsdg(10_000);
        assertEq(treasury.backingPerToken(), 0, "no division by zero before genesis");
    }

    // ── The Morpho haircut ──

    function test_morphoAssets_areMarkedDownByTheHaircut() public {
        _fundUsdg(10_000);
        treasury.rebalanceToMorpho(6_000e6); // 60%, under the 70% cap

        assertEq(treasury.morphoAssets(), 6_000e18, "gross deployed assets");
        // 4,000 liquid + 6,000 × 98% = 9,880
        assertEq(treasury.rfv(), 9_880e18, "deployed reserves are marked down 2% for prudence");
    }

    function test_haircut_understatesReservesRatherThanLosingThem() public {
        _fundUsdg(10_000);
        uint256 before = treasury.rfv();

        treasury.rebalanceToMorpho(7_000e6);
        uint256 afterDeposit = treasury.rfv();

        // No value left the treasury; only the measurement got more conservative.
        assertLt(afterDeposit, before, "measured RFV dips by the haircut");
        assertEq(before - afterDeposit, 7_000e18 * Constants.MORPHO_HAIRCUT_BPS / Constants.BPS);
        // At the 70% cap the understatement is bounded at 1.4% of reserves.
        assertApproxEqRel(before - afterDeposit, before * 14 / 1000, 0.001e18);
    }

    function test_morphoYield_raisesRfv() public {
        _fundUsdg(10_000);
        treasury.rebalanceToMorpho(7_000e6);
        uint256 before = treasury.rfv();

        vault.accrue(700e6); // 10% yield on the deployed sleeve

        assertGt(treasury.rfv(), before, "yield accrues into backing");
    }

    // ── Morpho cap ──

    function test_rebalanceToMorpho_enforcesSeventyPercentCap() public {
        _fundUsdg(10_000);

        vm.expectRevert(Treasury.MorphoCapExceeded.selector);
        treasury.rebalanceToMorpho(7_001e6);
    }

    function test_rebalanceToMorpho_allowsExactlyTheCap() public {
        _fundUsdg(10_000);
        treasury.rebalanceToMorpho(7_000e6);
        assertEq(treasury.morphoAssets(), 7_000e18);
    }

    function test_rebalanceToMorpho_isPermissionless() public {
        _fundUsdg(10_000);

        vm.prank(alice);
        treasury.rebalanceToMorpho(5_000e6);

        assertEq(treasury.morphoAssets(), 5_000e18, "anyone may rebalance within the cap");
    }

    /// @dev Upstream deliberately only lets a permissionless withdrawal trim
    ///      back DOWN TO the cap. Otherwise an attacker could flush the sleeve
    ///      to liquid, griefing yield and inflating InverseBond's liquid-keyed
    ///      epoch capacity.
    function test_rebalanceFromMorpho_cannotFlushTheSleeve() public {
        _fundUsdg(10_000);
        treasury.rebalanceToMorpho(7_000e6);

        vm.prank(alice);
        vm.expectRevert(Treasury.MorphoCapExceeded.selector);
        treasury.rebalanceFromMorpho(1_000e6);
    }

    /// @dev Withdrawal may trim the deployed fraction down TO the cap and not a
    ///      wei further, so the allowed amount is exactly the overflow. Here:
    ///      8,000 deployed of 11,000 total is 72.7%; 70% of 11,000 is 7,700, so
    ///      300 may come out and 301 may not.
    function test_rebalanceFromMorpho_trimsExactlyTheYieldOverflow() public {
        _fundUsdg(10_000);
        treasury.rebalanceToMorpho(7_000e6);
        vault.accrue(1_000e6); // deployed fraction now exceeds 70%

        treasury.rebalanceFromMorpho(300e6);
        assertEq(treasury.morphoAssets(), 7_700e18, "trimmed back to precisely the cap");
    }

    function test_rebalanceFromMorpho_cannotTrimBelowTheCap() public {
        _fundUsdg(10_000);
        treasury.rebalanceToMorpho(7_000e6);
        vault.accrue(1_000e6);

        vm.expectRevert(Treasury.MorphoCapExceeded.selector);
        treasury.rebalanceFromMorpho(301e6);
    }

    function test_rebalanceFromMorpho_cannotWithdrawMoreThanDeployed() public {
        _fundUsdg(10_000);
        treasury.rebalanceToMorpho(5_000e6);

        vm.expectRevert(Treasury.MorphoCapExceeded.selector);
        treasury.rebalanceFromMorpho(6_000e6);
    }

    // ── Minting authority ──

    function test_mintMoass_onlyWiredMinters() public {
        vm.prank(alice);
        vm.expectRevert(Treasury.NotMinter.selector);
        treasury.mintMoass(alice, 1e9);
    }

    function test_mintMoass_worksForAWiredMinter() public {
        vm.prank(minter);
        treasury.mintMoass(alice, 1_000e9);
        assertEq(moass.balanceOf(alice), 1_000e9);
    }

    function test_wire_isSingleUse() public {
        address[] memory more = new address[](1);
        more[0] = alice;

        vm.expectRevert(Wired.AlreadyWired.selector);
        treasury.wire(more, more);
    }

    /// @dev The security claim worth restating: after wiring there is no
    ///      function anywhere on this contract that can grant minting rights.
    function test_noFunctionCanAddAMinterAfterWiring() public {
        assertFalse(treasury.isMinter(alice));

        address[] memory more = new address[](1);
        more[0] = alice;
        vm.expectRevert(Wired.AlreadyWired.selector);
        treasury.wire(more, more);

        assertFalse(treasury.isMinter(alice), "the minter set is frozen at deploy");
    }

    function test_mintMoass_revertsBeforeWiring() public {
        Treasury fresh = new Treasury(address(moass), address(usdg), address(vault), address(pair));
        vm.prank(minter);
        vm.expectRevert(Wired.NotWired.selector);
        fresh.mintMoass(alice, 1e9);
    }

    // ── Spending ──

    function test_spendUsdg_onlyWiredSpenders() public {
        _fundUsdg(1_000);
        vm.prank(alice);
        vm.expectRevert(Treasury.NotSpender.selector);
        treasury.spendUsdg(alice, 100e6);
    }

    function test_spendUsdg_transfersFromLiquid() public {
        _fundUsdg(1_000);

        vm.prank(spender);
        treasury.spendUsdg(alice, 400e6);

        assertEq(usdg.balanceOf(alice), 400e6);
        assertEq(treasury.liquidUsdg(), 600e18);
    }

    /// @dev The buyback must always be payable, even with reserves deployed.
    function test_spendUsdg_autoUnwindsTheSleeveWhenLiquidIsShort() public {
        _fundUsdg(10_000);
        treasury.rebalanceToMorpho(7_000e6); // only 3,000 left liquid

        vm.prank(spender);
        treasury.spendUsdg(alice, 5_000e6);

        assertEq(usdg.balanceOf(alice), 5_000e6, "the sleeve unwound to cover the obligation");
    }

    // ── Protocol-owned liquidity ──

    function test_polRfv_isZeroWithoutLpTokens() public view {
        assertEq(treasury.polRfv(), 0);
    }

    function test_polRfv_valuesTheMoassLegAtItsFloorNotTheMarket() public {
        // Pool holds 1,000 MOASS and 4,000 USDG, so MOASS trades at $4.
        pair.setReserves(
            address(moass) < address(usdg) ? uint112(1_000e9) : uint112(4_000e6),
            address(moass) < address(usdg) ? uint112(4_000e6) : uint112(1_000e9)
        );
        pair.mintLp(address(treasury), 100e18);
        // The treasury owns the whole pool.
        vm.store(address(pair), bytes32(uint256(5)), bytes32(uint256(100e18)));

        // RFV of the LP is 2·√(x·y) with the MOASS leg at its $1 floor:
        // 2·√(4000 × 1000) = 2 × 2000 = 4,000, NOT the $8,000 market value.
        assertApproxEqRel(treasury.polRfv(), 4_000e18, 0.001e18, "POL is valued at intrinsic, not market");
    }

    // ── What the reserve swap changes ──

    /// @dev Documents the assumption the GME swap has to confront. The reserve
    ///      token is the unit of account, and `Distributor` stops minting once
    ///      `totalSupply × 1 reserve unit ≥ rfv()`. So "one reserve unit" IS the
    ///      floor price of one MOASS. With a $1 stablecoin that floor is fixed;
    ///      with GME it becomes one GME per MOASS and moves with the market.
    function test_reserveUnit_isTheImplicitFloorPrice() public {
        _fundUsdg(1_000);
        moass.mint(alice, 1_000e9);

        assertEq(treasury.backingPerToken(), 1e18, "exactly one reserve unit per MOASS");

        // This is the point at which emissions stop, by construction.
        assertEq(
            moass.totalSupply() * Constants.MOASS_UNIT,
            treasury.rfv(),
            "supply valued at one reserve unit each has reached reserves"
        );
    }

    // ── Fuzz ──

    function testFuzz_backingPerToken_neverRevertsAndTracksRfv(uint96 usdgWhole, uint96 supply) public {
        uint256 whole = bound(uint256(usdgWhole), 0, 1_000_000_000);
        uint256 mintAmount = bound(uint256(supply), 1e9, 1_000_000_000e9);

        _fundUsdg(whole);
        moass.mint(alice, mintAmount);

        uint256 expected = treasury.rfv() * Constants.MOASS_UNIT / moass.totalSupply();
        assertEq(treasury.backingPerToken(), expected);
    }

    function testFuzz_rebalanceToMorpho_neverExceedsTheCap(uint96 amount) public {
        _fundUsdg(10_000);
        uint256 assets = bound(uint256(amount), 1, 10_000e6);

        if (assets > 7_000e6) {
            vm.expectRevert(Treasury.MorphoCapExceeded.selector);
            treasury.rebalanceToMorpho(assets);
        } else {
            treasury.rebalanceToMorpho(assets);
            assertLe(
                treasury.morphoAssets() * Constants.BPS,
                (treasury.liquidUsdg() + treasury.morphoAssets()) * Constants.MORPHO_CAP_BPS,
                "deployed fraction stays under the cap"
            );
        }
    }
}
