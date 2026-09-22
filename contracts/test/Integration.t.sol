// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployLib, Deployment, Externals} from "../script/Deploy.s.sol";
import {MOASS} from "../src/MOASS.sol";
import {StakedMOASS} from "../src/StakedMOASS.sol";
import {Staking} from "../src/Staking.sol";
import {Distributor} from "../src/Distributor.sol";
import {Treasury} from "../src/Treasury.sol";
import {BondDepository} from "../src/BondDepository.sol";
import {PairOracle} from "../src/PairOracle.sol";
import {GenesisBond} from "../src/GenesisBond.sol";
import {InverseBond} from "../src/InverseBond.sol";
import {PTeam} from "../src/PTeam.sol";
import {ShareCertificate} from "../src/ShareCertificate.sol";
import {Constants} from "../src/Constants.sol";
import {MockERC20, MockERC4626, MockPair, MockRouter, MockV2Factory, MockV3Factory} from "./mocks/Mocks.sol";

/// @notice The whole protocol, deployed by the real deploy script and driven
///         through a full lifecycle: subscribe → finalise → stake → rebase →
///         bond → redeem → buy back.
///
/// The unit suites prove each contract behaves; this proves they behave
/// together, and that `script/Deploy.s.sol` wires them correctly — it is the
/// same code that will run against testnet, not an approximation of it.
contract IntegrationTest is Test {
    Deployment internal d;

    MOASS internal moass;
    StakedMOASS internal sMoass;
    Staking internal staking;
    Distributor internal distributor;
    Treasury internal treasury;
    BondDepository internal depo;
    PairOracle internal oracle;
    GenesisBond internal genesis;
    InverseBond internal inverse;
    PTeam internal pTeam;

    MockERC20 internal reserve;
    MockPair internal pair;
    MockRouter internal router;
    MockERC4626 internal vault;

    address internal guardian;
    address internal teamWallet;
    address internal alice;
    address internal bob;

    /// @dev Genesis parameters, from Constants: $3/MOASS, 50k hard cap,
    ///      2k wallet cap, 15k minimum, 7-day window, 70/30 treasury/POL.
    uint256 internal constant WALLET_CAP = 2_000e6;

    function setUp() public {
        vm.warp(1_800_000_000);
        guardian = makeAddr("guardian");
        teamWallet = makeAddr("teamWallet");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        reserve = new MockERC20("USDG", "USDG", 6);
        vault = new MockERC4626(reserve);
        router = new MockRouter(new MockERC20("unused", "X", 9), reserve);

        // The pair must exist before the protocol is deployed against it, so
        // MOASS's address is precomputed the way a real deploy would.
        address predictedMoass = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        pair = new MockPair(predictedMoass, address(reserve));

        MockV2Factory v2Factory = new MockV2Factory();
        MockV3Factory v3Factory = new MockV3Factory();
        v2Factory.setPair(pair.token0(), pair.token1(), address(pair));

        d = DeployLib.deploy(
            Externals({
                reserve: address(reserve),
                pair: address(pair),
                router: address(router),
                v2Factory: address(v2Factory),
                v3Factory: address(v3Factory),
                yieldVault: address(vault),
                guardian: guardian,
                teamWallet: teamWallet
            })
        );

        moass = MOASS(d.moass);
        sMoass = StakedMOASS(d.sMoass);
        staking = Staking(d.staking);
        distributor = Distributor(d.distributor);
        treasury = Treasury(d.treasury);
        depo = BondDepository(d.bondDepository);
        oracle = PairOracle(d.oracle);
        genesis = GenesisBond(d.genesisBond);
        inverse = InverseBond(d.inverseBond);
        pTeam = PTeam(d.pTeam);

        assertEq(d.moass, predictedMoass, "the pair was built against the right token");

        reserve.mint(alice, 1_000_000e6);
        reserve.mint(bob, 1_000_000e6);
        vm.prank(alice);
        reserve.approve(address(genesis), type(uint256).max);
        vm.prank(bob);
        reserve.approve(address(genesis), type(uint256).max);
    }

    // ── Deployment ──

    function test_deploy_producesAFullyWiredProtocol() public view {
        assertTrue(moass.wired());
        assertTrue(sMoass.wired());
        assertTrue(staking.wired());
        assertTrue(treasury.wired());
        assertTrue(depo.wired());
        assertTrue(genesis.wired());
        assertTrue(pTeam.wired());
    }

    function test_deploy_fixesTheMinterSet() public view {
        assertTrue(treasury.isMinter(d.distributor));
        assertTrue(treasury.isMinter(d.genesisBond));
        assertTrue(treasury.isMinter(d.bondDepository));
        assertTrue(treasury.isMinter(d.premiumSeller));
        assertTrue(treasury.isMinter(d.pTeam));

        assertFalse(treasury.isMinter(guardian), "not even the guardian can mint");
        assertFalse(treasury.isMinter(teamWallet));
        assertFalse(treasury.isMinter(address(this)), "not even the deployer");
    }

    function test_deploy_leavesNothingDormantThatShouldBeOn() public view {
        // Everything stays off until genesis finalises: no staking, no bonds,
        // no tax, no buyback.
        assertFalse(staking.enabled());
        assertFalse(depo.enabled());
        assertFalse(moass.taxEnabled());
        assertFalse(inverse.active());
        assertEq(moass.totalSupply(), 0, "no MOASS exists before the sale settles");
    }

    // ── The sale ──

    function test_purchase_recordsASoulboundCertificate() public {
        vm.prank(alice);
        genesis.purchase(1_000e6);

        assertEq(genesis.purchasedRaw(alice), 1_000e6);
        assertEq(genesis.registryLength(), 1);

        ShareCertificate cert = ShareCertificate(d.certificate);
        assertEq(cert.balanceOf(alice), 1, "a founding shareholder certificate");
        vm.prank(alice);
        vm.expectRevert(ShareCertificate.Soulbound.selector);
        cert.transferFrom(alice, bob, 1);
    }

    function test_purchase_enforcesTheWalletCap() public {
        vm.prank(alice);
        genesis.purchase(WALLET_CAP);

        vm.prank(alice);
        vm.expectRevert(GenesisBond.WalletCapExceeded.selector);
        genesis.purchase(1e6);
    }

    function test_purchase_closesAfterTheDeadline() public {
        skip(Constants.GENESIS_DEADLINE + 1);

        vm.prank(alice);
        vm.expectRevert(GenesisBond.SaleClosed.selector);
        genesis.purchase(100e6);
    }

    function test_finalize_revertsBelowTheMinimumRaise() public {
        vm.prank(alice);
        genesis.purchase(1_000e6);
        skip(Constants.GENESIS_DEADLINE + 1);

        vm.expectRevert(GenesisBond.CannotFinalize.selector);
        genesis.finalize();
    }

    function test_refund_isAvailableWhenTheSaleFails() public {
        vm.prank(alice);
        genesis.purchase(1_000e6);
        skip(Constants.GENESIS_DEADLINE + 1);

        uint256 before = reserve.balanceOf(alice);
        vm.prank(alice);
        genesis.refund();

        assertEq(reserve.balanceOf(alice) - before, 1_000e6, "money back if the raise misses");
    }

    function test_refund_revertsOnceTheSaleSucceeded() public {
        _raiseMinimum();
        genesis.finalize();

        vm.prank(alice);
        vm.expectRevert(GenesisBond.SaleNotFailed.selector);
        genesis.refund();
    }

    // ── Finalise: the atomic switch ──

    function test_finalize_turnsTheWholeProtocolOnAtOnce() public {
        _raiseMinimum();
        genesis.finalize();

        assertTrue(staking.enabled(), "staking live");
        assertTrue(depo.enabled(), "bonds live");
        assertTrue(moass.taxEnabled(), "tax live");
        assertEq(moass.canonicalPair(), address(pair));
        assertGt(genesis.finalizeTime(), 0, "the pTEAM and tax-decay clock started");

        // The buyback is armed but cannot quote yet: finalize() left a fresh
        // oracle checkpoint, and a TWAP needs one at least 30 minutes old.
        assertFalse(inverse.active(), "no live TWAP yet");
        _matureOracle();
        assertTrue(inverse.active(), "the floor bid stands once pricing is live");
    }

    function test_finalize_splitsProceedsSeventyThirty() public {
        uint256 raised = _raiseMinimum();
        genesis.finalize();

        uint256 toTreasury = raised * Constants.TREASURY_SPLIT_BPS / Constants.BPS;
        assertEq(reserve.balanceOf(address(treasury)), toTreasury, "70% to reserves");
        assertEq(reserve.balanceOf(address(pair)), raised - toTreasury, "30% seeds the pool");
    }

    function test_finalize_seedsThePoolAtTheGenesisPriceAndKeepsTheLp() public {
        _raiseMinimum();
        genesis.finalize();

        assertGt(pair.balanceOf(address(treasury)), 0, "LP is protocol-owned from day one");
        assertEq(pair.balanceOf(address(this)), 0, "the deployer keeps none of it");

        // Pool seeded at $3/MOASS, the genesis price.
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 moassR, uint256 quoteR) =
            pair.token0() == address(moass) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        assertApproxEqRel(quoteR * 1e12 * 1e9 / moassR, 3e18, 0.001e18);
    }

    function test_finalize_isSingleUse() public {
        _raiseMinimum();
        genesis.finalize();

        vm.expectRevert(GenesisBond.AlreadyFinalized.selector);
        genesis.finalize();
    }

    function test_finalize_vestsBuyersOverFiveDays() public {
        _raiseMinimum();
        genesis.finalize();

        uint256 owed = genesis.purchasedMoassOf(alice);
        assertGt(owed, 0);
        assertEq(genesis.claimableMoassOf(alice), 0, "nothing at t=0");

        skip(Constants.GENESIS_VEST / 2);
        assertApproxEqRel(genesis.claimableMoassOf(alice), owed / 2, 0.001e18);

        skip(Constants.GENESIS_VEST / 2);
        vm.prank(alice);
        uint256 claimed = genesis.claim();
        assertEq(claimed, owed);
        assertEq(moass.balanceOf(alice), owed);
    }

    // ── The full lifecycle ──

    /// @dev One pass through everything a user can do, against the real wiring.
    function test_lifecycle_subscribeStakeRebaseBondRedeemSell() public {
        // 1. Subscribe and launch.
        _raiseMinimum();
        genesis.finalize();
        skip(Constants.GENESIS_VEST);

        vm.prank(alice);
        genesis.claim();
        uint256 initial = moass.balanceOf(alice);
        assertGt(initial, 0);

        // 2. Stake. The protocol treats staked MOASS 1:1, no warm-up.
        vm.startPrank(alice);
        moass.approve(address(staking), type(uint256).max);
        staking.stake(alice, initial);
        vm.stopPrank();
        assertEq(sMoass.balanceOf(alice), initial, "1:1, immediately");

        // 3. Let the oracle mature so emissions can price, then rebase.
        _matureOracle();
        uint256 balanceBeforeRebase = sMoass.balanceOf(alice);
        _advanceEpochs(3);
        assertGt(sMoass.balanceOf(alice), balanceBeforeRebase, "rebases landed");
        assertGe(
            moass.balanceOf(address(staking)),
            sMoass.circulatingSupply(),
            "every fragment stays redeemable"
        );

        // 4. Bond reserves for discounted MOASS.
        vm.startPrank(bob);
        reserve.approve(address(depo), type(uint256).max);
        // Sized under the per-epoch throttle: 0.25% of a ~6,500 supply is only
        // about 16 MOASS, so a large bond would be rejected outright.
        (, uint256 payout) = depo.deposit(0, 30e6, type(uint256).max, bob);
        vm.stopPrank();
        assertGt(payout, 0);

        // 5. Redeem once vested.
        skip(Constants.BOND_VEST);
        vm.prank(bob);
        uint256 redeemed = depo.redeem(bob);
        assertEq(redeemed, payout, "the whole note vested");

        // 6. Unstake, and confirm backing never went backwards.
        uint256 backing = treasury.backingPerToken();
        vm.startPrank(alice);
        sMoass.approve(address(staking), type(uint256).max);
        staking.unstake(alice, sMoass.balanceOf(alice));
        vm.stopPrank();
        assertEq(treasury.backingPerToken(), backing, "staking movements never touch backing");
    }

    /// @dev Bonding must always be accretive: reserves per token after a bond
    ///      is never lower than before, however large the bond.
    function test_bondingIsAlwaysAccretiveToBacking() public {
        _raiseMinimum();
        genesis.finalize();
        _matureOracle();

        vm.startPrank(bob);
        reserve.approve(address(depo), type(uint256).max);

        for (uint256 i = 0; i < 5; i++) {
            uint256 before = treasury.backingPerToken();
            depo.deposit(0, 20e6, type(uint256).max, bob);
            assertGe(treasury.backingPerToken(), before, "a bond never dilutes the floor");
            _advanceWithKeeper(Constants.EPOCH_LENGTH);
        }
        vm.stopPrank();
    }

    function test_taxIsLiveOnTheCanonicalPairAfterLaunch() public {
        _raiseMinimum();
        genesis.finalize();
        skip(Constants.GENESIS_VEST);
        vm.prank(alice);
        genesis.claim();

        uint256 amount = 100e9;
        vm.prank(alice);
        moass.transfer(address(pair), amount);

        assertEq(
            moass.balanceOf(d.taxCollector),
            amount * Constants.TAX_TOTAL_BPS / Constants.BPS,
            "5% of a sell reaches the collector"
        );
    }

    function test_protocolContractsAreExemptFromTheTax() public {
        _raiseMinimum();
        genesis.finalize();

        assertTrue(moass.isTaxExempt(address(treasury)));
        assertTrue(moass.isTaxExempt(address(staking)));
        assertTrue(moass.isTaxExempt(address(depo)));
        assertFalse(moass.isTaxExempt(address(pair)), "the pair itself is never exempt");
    }

    /// @dev The headline safety property across the whole system: MOASS in
    ///      existence, valued at one reserve unit each, never exceeds the
    ///      treasury's reserves.
    function test_invariant_supplyNeverOutrunsReserves() public {
        _raiseMinimum();
        genesis.finalize();
        _matureOracle();

        vm.startPrank(bob);
        reserve.approve(address(depo), type(uint256).max);
        vm.stopPrank();

        for (uint256 i = 0; i < 10; i++) {
            _advanceEpochs(1);
            vm.prank(bob);
            depo.deposit(0, 20e6, type(uint256).max, bob);

            assertLe(
                moass.totalSupply() * Constants.MOASS_UNIT,
                treasury.rfv(),
                "supply outran the reserves backing it"
            );
        }
    }

    // ── Helpers ──

    /// @dev Raises exactly the minimum across enough wallets to clear the cap.
    function _raiseMinimum() internal returns (uint256 raised) {
        uint256 needed = Constants.GENESIS_MIN_RAISE_WAD / 1e12; // to 6-decimal raw
        uint256 perWallet = WALLET_CAP;
        uint256 wallets = (needed + perWallet - 1) / perWallet;

        for (uint256 i = 0; i < wallets; i++) {
            address buyer = i == 0 ? alice : (i == 1 ? bob : makeAddr(string(abi.encode("buyer", i))));
            uint256 amount = i == wallets - 1 ? needed - raised : perWallet;
            reserve.mint(buyer, amount);
            vm.startPrank(buyer);
            reserve.approve(address(genesis), type(uint256).max);
            genesis.purchase(amount);
            vm.stopPrank();
            raised += amount;
        }
        skip(Constants.GENESIS_DEADLINE + 1);
    }

    /// @dev Gives the oracle a usable observation window. Without one, the
    ///      Distributor mints nothing and bonds refuse to price.
    function _matureOracle() internal {
        oracle.checkpoint();
        _advanceWithKeeper(Constants.TWAP_MIN_WINDOW);
    }

    /// @dev Advances time while poking the oracle every 30 minutes, as a keeper
    ///      or ordinary traffic would.
    ///
    ///      This is an operational requirement, not a test convenience: a TWAP
    ///      is only readable from an observation aged 30 minutes to 4 hours, and
    ///      `Staking.rebase()` only fires every 8 hours. Left to the rebase
    ///      alone the newest observation is always 8 hours old, permanently out
    ///      of band — emissions would mint zero forever and bonds would never
    ///      price. SOMETHING must call `checkpoint()` at least every 4 hours.
    function _advanceWithKeeper(uint256 secs) internal {
        uint256 remaining = secs;
        while (remaining > 0) {
            uint256 step = remaining < Constants.CHECKPOINT_MIN_INTERVAL
                ? remaining
                : Constants.CHECKPOINT_MIN_INTERVAL;
            skip(step);
            oracle.checkpoint();
            remaining -= step;
        }
    }

    function _advanceEpochs(uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            _advanceWithKeeper(Constants.EPOCH_LENGTH);
            staking.rebase();
        }
    }
}
