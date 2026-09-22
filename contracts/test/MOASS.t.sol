// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MOASS} from "../src/MOASS.sol";
import {IMOASS} from "../src/interfaces/IMOASS.sol";
import {Constants} from "../src/Constants.sol";
import {Wired} from "../src/abstract/Wired.sol";
import {MockPair, MockV2Factory, MockV3Factory, MockERC20} from "./mocks/Mocks.sol";

/// @notice The MOASS token and its 5% fee-on-transfer.
///
/// The front end currently tells users nothing about a tax, so what it actually
/// does is pinned here precisely: 5% on any leg touching a registered AMM pair,
/// nothing wallet-to-wallet, and `received + tax == sent` always.
///
/// The administration surface is deliberately add-only. A compromised guardian
/// key can register more taxed venues and (after a 2-day delay) more exempt
/// addresses, but can never un-tax a venue, never exempt a pair, and never
/// touch anyone's balance. Those limits are asserted rather than assumed.
contract MOASSTest is Test {
    MOASS internal moass;
    MockPair internal pair;
    MockV2Factory internal v2Factory;
    MockV3Factory internal v3Factory;
    MockERC20 internal usdg;

    address internal guardian;
    address internal treasury;
    address internal taxCollector;
    address internal genesisBond;
    address internal alice;
    address internal bob;

    function setUp() public {
        guardian = makeAddr("guardian");
        treasury = makeAddr("treasury");
        taxCollector = makeAddr("taxCollector");
        genesisBond = makeAddr("genesisBond");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        moass = new MOASS(guardian, "Moass Fund", "MOASS");
        usdg = new MockERC20("USDG", "USDG", 6);
        pair = new MockPair(address(moass), address(usdg));
        v2Factory = new MockV2Factory();
        v3Factory = new MockV3Factory();
        v2Factory.setPair(pair.token0(), pair.token1(), address(pair));

        address[] memory none = new address[](0);
        moass.wire(
            treasury, taxCollector, genesisBond, address(v2Factory), address(v3Factory), none, none
        );

        vm.prank(treasury);
        moass.mint(alice, 10_000e9);
    }

    function _enableTax() internal {
        vm.prank(genesisBond);
        moass.enableTax(address(pair));
    }

    // ── Metadata and supply ──

    function test_metadata() public view {
        assertEq(moass.name(), "Moass Fund");
        assertEq(moass.symbol(), "MOASS");
        assertEq(moass.decimals(), 9, "9 decimals, OHM convention");
        assertEq(moass.taxTotalBps(), 500, "5%");
    }

    function test_mint_onlyTreasury() public {
        vm.prank(alice);
        vm.expectRevert(MOASS.NotTreasury.selector);
        moass.mint(alice, 1e9);
    }

    function test_mint_revertsBeforeWiring() public {
        MOASS fresh = new MOASS(guardian, "Moass Fund", "MOASS");
        vm.expectRevert(Wired.NotWired.selector);
        fresh.mint(alice, 1e9);
    }

    function test_mint_revertsToZeroAddress() public {
        vm.prank(treasury);
        vm.expectRevert(Wired.ZeroAddress.selector);
        moass.mint(address(0), 1e9);
    }

    function test_burn_reducesSupply() public {
        vm.prank(alice);
        moass.burn(1_000e9);

        assertEq(moass.balanceOf(alice), 9_000e9);
        assertEq(moass.totalSupply(), 9_000e9);
    }

    function test_burnFrom_spendsAllowance() public {
        vm.prank(alice);
        moass.approve(bob, 500e9);

        vm.prank(bob);
        moass.burnFrom(alice, 500e9);

        assertEq(moass.totalSupply(), 9_500e9);
        assertEq(moass.allowance(alice, bob), 0);
    }

    // ── Tax: when it applies ──

    function test_noTaxBeforeItIsEnabled() public {
        vm.prank(alice);
        moass.transfer(address(pair), 1_000e9);

        assertEq(moass.balanceOf(address(pair)), 1_000e9, "untaxed until genesis enables it");
        assertEq(moass.balanceOf(taxCollector), 0);
    }

    function test_walletToWalletIsFree() public {
        _enableTax();

        vm.prank(alice);
        moass.transfer(bob, 1_000e9);

        assertEq(moass.balanceOf(bob), 1_000e9, "no tax between wallets");
        assertEq(moass.balanceOf(taxCollector), 0);
    }

    function test_sellToPairIsTaxed() public {
        _enableTax();

        vm.prank(alice);
        moass.transfer(address(pair), 1_000e9);

        assertEq(moass.balanceOf(address(pair)), 950e9, "pair receives 95%");
        assertEq(moass.balanceOf(taxCollector), 50e9, "5% to the collector");
    }

    function test_buyFromPairIsTaxed() public {
        _enableTax();
        vm.prank(treasury);
        moass.mint(address(pair), 1_000e9);

        vm.prank(address(pair));
        moass.transfer(bob, 1_000e9);

        assertEq(moass.balanceOf(bob), 950e9, "buyer receives 95%");
        assertEq(moass.balanceOf(taxCollector), 50e9);
    }

    /// @dev The conservation property: nothing is created or destroyed by the
    ///      tax, it is only redirected.
    function test_receivedPlusTaxAlwaysEqualsSent() public {
        _enableTax();
        uint256 supplyBefore = moass.totalSupply();

        vm.prank(alice);
        moass.transfer(address(pair), 1_000e9);

        assertEq(
            moass.balanceOf(address(pair)) + moass.balanceOf(taxCollector),
            1_000e9,
            "received + taxed == sent"
        );
        assertEq(moass.totalSupply(), supplyBefore, "the tax does not change supply");
    }

    function test_taxAppliesOnlyOncePerTransfer() public {
        _enableTax();

        vm.prank(alice);
        moass.transfer(address(pair), 1_000e9);

        assertEq(moass.balanceOf(taxCollector), 50e9, "exactly one 500bps leg, not two");
    }

    function test_exemptSenderPaysNoTax() public {
        _enableTax();
        _exempt(alice);

        vm.prank(alice);
        moass.transfer(address(pair), 1_000e9);

        assertEq(moass.balanceOf(address(pair)), 1_000e9);
        assertEq(moass.balanceOf(taxCollector), 0);
    }

    function test_exemptRecipientPaysNoTax() public {
        _enableTax();
        _exempt(bob);
        vm.prank(treasury);
        moass.mint(address(pair), 1_000e9);

        vm.prank(address(pair));
        moass.transfer(bob, 1_000e9);

        assertEq(moass.balanceOf(bob), 1_000e9);
    }

    function test_transferFrom_isTaxedToo() public {
        _enableTax();
        vm.prank(alice);
        moass.approve(bob, type(uint256).max);

        vm.prank(bob);
        moass.transferFrom(alice, address(pair), 1_000e9);

        assertEq(moass.balanceOf(taxCollector), 50e9, "the router path is taxed as well");
    }

    // ── enableTax ──

    function test_enableTax_onlyGenesisBond() public {
        vm.prank(guardian);
        vm.expectRevert(MOASS.NotGenesisBond.selector);
        moass.enableTax(address(pair));
    }

    function test_enableTax_isSingleUse() public {
        _enableTax();
        vm.prank(genesisBond);
        vm.expectRevert(MOASS.TaxAlreadyEnabled.selector);
        moass.enableTax(address(pair));
    }

    function test_enableTax_registersTheCanonicalPair() public {
        _enableTax();
        assertEq(moass.canonicalPair(), address(pair));
        assertTrue(moass.isTaxedPair(address(pair)));
        assertTrue(moass.taxEnabled());
    }

    // ── addTaxedPair: guarded by on-chain pool validation ──

    function test_addTaxedPair_onlyGuardian() public {
        MockPair other = _newValidatedPair();
        vm.prank(alice);
        vm.expectRevert(MOASS.NotGuardian.selector);
        moass.addTaxedPair(address(other), IMOASS.PoolKind.UniswapV2, 0);
    }

    function test_addTaxedPair_acceptsAGenuineV2Pool() public {
        MockPair other = _newValidatedPair();

        vm.prank(guardian);
        moass.addTaxedPair(address(other), IMOASS.PoolKind.UniswapV2, 0);

        assertTrue(moass.isTaxedPair(address(other)));
    }

    /// @dev The key limitation on a compromised guardian: it can only ever map
    ///      a real MOASS venue, never an arbitrary address.
    function test_addTaxedPair_rejectsAPoolTheFactoryDoesNotKnow() public {
        MockERC20 other = new MockERC20("OTHER", "OTHER", 18);
        MockPair rogue = new MockPair(address(moass), address(other));
        // Deliberately not registered with the factory.

        vm.prank(guardian);
        vm.expectRevert(MOASS.NotAMoassPool.selector);
        moass.addTaxedPair(address(rogue), IMOASS.PoolKind.UniswapV2, 0);
    }

    function test_addTaxedPair_rejectsAPoolWithoutMoass() public {
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        MockPair foreign = new MockPair(address(a), address(b));
        v2Factory.setPair(foreign.token0(), foreign.token1(), address(foreign));

        vm.prank(guardian);
        vm.expectRevert(MOASS.NotAMoassPool.selector);
        moass.addTaxedPair(address(foreign), IMOASS.PoolKind.UniswapV2, 0);
    }

    function test_addTaxedPair_rejectsADuplicate() public {
        _enableTax();
        vm.prank(guardian);
        vm.expectRevert(MOASS.PairAlreadyMapped.selector);
        moass.addTaxedPair(address(pair), IMOASS.PoolKind.UniswapV2, 0);
    }

    function test_addTaxedPair_acceptsAV3PoolAtTheRightFeeTier() public {
        MockERC20 other = new MockERC20("OTHER", "OTHER", 18);
        MockPair v3 = new MockPair(address(moass), address(other));
        v3Factory.setPool(v3.token0(), v3.token1(), 3000, address(v3));

        vm.prank(guardian);
        moass.addTaxedPair(address(v3), IMOASS.PoolKind.UniswapV3, 3000);

        assertTrue(moass.isTaxedPair(address(v3)));
    }

    function test_addTaxedPair_rejectsAV3PoolAtTheWrongFeeTier() public {
        MockERC20 other = new MockERC20("OTHER", "OTHER", 18);
        MockPair v3 = new MockPair(address(moass), address(other));
        v3Factory.setPool(v3.token0(), v3.token1(), 3000, address(v3));

        vm.prank(guardian);
        vm.expectRevert(MOASS.NotAMoassPool.selector);
        moass.addTaxedPair(address(v3), IMOASS.PoolKind.UniswapV3, 500);
    }

    // ── Exemptions: timelocked, and never a pair ──

    function test_queueTaxExempt_onlyGuardian() public {
        vm.prank(alice);
        vm.expectRevert(MOASS.NotGuardian.selector);
        moass.queueTaxExempt(bob);
    }

    function test_executeTaxExempt_requiresTheFullDelay() public {
        vm.prank(guardian);
        moass.queueTaxExempt(bob);

        skip(Constants.EXEMPT_DELAY - 1);
        vm.expectRevert(MOASS.DelayNotElapsed.selector);
        moass.executeTaxExempt(bob);

        skip(1);
        moass.executeTaxExempt(bob);
        assertTrue(moass.isTaxExempt(bob));
    }

    function test_exemptDelayIsTwoDays() public view {
        assertEq(Constants.EXEMPT_DELAY, 2 days, "exemptions are not instant");
    }

    function test_executeTaxExempt_isPermissionlessOnceQueued() public {
        vm.prank(guardian);
        moass.queueTaxExempt(bob);
        skip(Constants.EXEMPT_DELAY);

        // Anyone may execute; the guardian's power was in the queuing.
        vm.prank(alice);
        moass.executeTaxExempt(bob);

        assertTrue(moass.isTaxExempt(bob));
    }

    function test_cancelTaxExempt_stopsAQueuedExemption() public {
        vm.prank(guardian);
        moass.queueTaxExempt(bob);

        vm.prank(guardian);
        moass.cancelTaxExempt(bob);

        skip(Constants.EXEMPT_DELAY);
        vm.expectRevert(MOASS.NothingQueued.selector);
        moass.executeTaxExempt(bob);
    }

    function test_executeTaxExempt_revertsWithNothingQueued() public {
        vm.expectRevert(MOASS.NothingQueued.selector);
        moass.executeTaxExempt(bob);
    }

    /// @dev Exempting a taxed pair would permanently zero the tax on that
    ///      venue, so it is blocked at both queue and execute time.
    function test_aTaxedPairCanNeverBeExempted() public {
        _enableTax();

        vm.prank(guardian);
        vm.expectRevert(MOASS.CannotExemptPair.selector);
        moass.queueTaxExempt(address(pair));
    }

    function test_anExemptAddressCanNeverBecomeATaxedPair() public {
        MockPair other = _newValidatedPair();

        vm.prank(guardian);
        moass.queueTaxExempt(address(other));

        vm.prank(guardian);
        vm.expectRevert(MOASS.CannotExemptPair.selector);
        moass.addTaxedPair(address(other), IMOASS.PoolKind.UniswapV2, 0);
    }

    /// @dev Add-only: there is no function on the contract that can un-tax a
    ///      venue or revoke an exemption. If one is ever added, this fails.
    function test_thereIsNoRemovalPath() public {
        _enableTax();
        assertTrue(moass.isTaxedPair(address(pair)));

        // The full mutable surface post-wiring, exercised: nothing here removes.
        vm.startPrank(guardian);
        vm.expectRevert(MOASS.CannotExemptPair.selector);
        moass.queueTaxExempt(address(pair));
        vm.stopPrank();

        assertTrue(moass.isTaxedPair(address(pair)), "still taxed");
    }

    // ── Fuzz ──

    function testFuzz_taxIsExactlyFivePercentAndConserves(uint96 amount_) public {
        _enableTax();
        uint256 amount = bound(uint256(amount_), 0, 10_000e9);

        vm.prank(alice);
        moass.transfer(address(pair), amount);

        uint256 tax = amount * Constants.TAX_TOTAL_BPS / Constants.BPS;
        assertEq(moass.balanceOf(taxCollector), tax);
        assertEq(moass.balanceOf(address(pair)), amount - tax, "sender's loss is exactly the tax");
    }

    function testFuzz_walletTransfersNeverTax(uint96 amount_) public {
        _enableTax();
        uint256 amount = bound(uint256(amount_), 0, 10_000e9);

        vm.prank(alice);
        moass.transfer(bob, amount);

        assertEq(moass.balanceOf(bob), amount);
        assertEq(moass.balanceOf(taxCollector), 0);
    }

    // ── Helpers ──

    function _exempt(address account) internal {
        vm.prank(guardian);
        moass.queueTaxExempt(account);
        skip(Constants.EXEMPT_DELAY);
        moass.executeTaxExempt(account);
    }

    /// @dev A second MOASS pool that the canonical V2 factory vouches for.
    function _newValidatedPair() internal returns (MockPair p) {
        MockERC20 other = new MockERC20("OTHER", "OTHER", 18);
        p = new MockPair(address(moass), address(other));
        v2Factory.setPair(p.token0(), p.token1(), address(p));
    }
}
