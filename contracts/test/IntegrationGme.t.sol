// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployLib, Deployment, Externals} from "../script/Deploy.s.sol";
import {MOASS} from "../src/MOASS.sol";
import {StakedMOASS} from "../src/StakedMOASS.sol";
import {Staking} from "../src/Staking.sol";
import {Treasury} from "../src/Treasury.sol";
import {BondDepository} from "../src/BondDepository.sol";
import {PairOracle} from "../src/PairOracle.sol";
import {GenesisBond} from "../src/GenesisBond.sol";
import {GmeDesk} from "../src/GmeDesk.sol";
import {Constants} from "../src/Constants.sol";
import {MockERC20, MockPair, MockRouter, MockV2Factory, MockV3Factory} from "./mocks/Mocks.sol";

/// @notice Moass Fund as it will actually be: the reserve asset is GME, and the
///         treasury's yield sleeve is the leveraged desk instead of a lending
///         vault.
///
/// This is the test that justifies the whole approach. Upstream's contracts
/// derive every decimal factor from `decimals()` at construction and treat the
/// reserve asset — not the dollar — as the unit of account. So moving from a
/// 6-decimal stablecoin to an 18-decimal equity token needs NO Solidity change
/// to Treasury, Distributor, BondDepository, InverseBond or anything else. It
/// is a deployment parameter plus one new contract in the vault slot.
///
/// The consequences are worth being explicit about, because they change what
/// the product is:
///   - `backingPerToken` is GME per MOASS, not dollars per MOASS. The UI
///     converts for display using the GME price it already fetches.
///   - the "floor" is one GME per MOASS, and it moves with GME. There is no
///     stable floor of the kind an ordinary OHM fork has.
contract IntegrationGmeTest is Test {
    Deployment internal d;

    MOASS internal moass;
    StakedMOASS internal sMoass;
    Staking internal staking;
    Treasury internal treasury;
    BondDepository internal depo;
    PairOracle internal oracle;
    GenesisBond internal genesis;
    GmeDesk internal desk;

    MockERC20 internal gme;
    MockPair internal pair;

    address internal teamWallet;
    address internal venue;
    address internal alice;
    address internal bob;

    /// @dev GME is 18 decimals, unlike the 6-decimal stablecoin upstream uses.
    /// @dev Derived, never duplicated: these tests must track Constants.
    uint256 internal constant WALLET_CAP = Constants.GENESIS_WALLET_CAP_WAD;

    function setUp() public {
        vm.warp(1_800_000_000);
        teamWallet = makeAddr("teamMultisig");
        venue = makeAddr("perpVenue");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        gme = new MockERC20("GameStop Robinhood Token", "GME", 18);

        // The pair has to exist before the protocol is deployed against it, and
        // it needs MOASS's address, which does not exist yet — so predict it
        // from the deployer's nonce, exactly as a real launch does. The desk
        // learns its treasury afterwards through `wire`, so it needs no
        // prediction at all.
        //
        // From here: pair n, desk n+1, v2Factory n+2, v3Factory n+3,
        // router's token n+4, router n+5, then MOASS at n+6.
        uint256 n = vm.getNonce(address(this));
        address predictedMoass = vm.computeCreateAddress(address(this), n + 6);

        pair = new MockPair(predictedMoass, address(gme));

        address[] memory venues = new address[](1);
        venues[0] = venue;
        desk = new GmeDesk(address(gme), teamWallet, venues, "Moass Fund GME Desk", "mGME");

        MockV2Factory v2Factory = new MockV2Factory();
        MockV3Factory v3Factory = new MockV3Factory();
        MockRouter router = new MockRouter(new MockERC20("x", "x", 9), gme);
        v2Factory.setPair(pair.token0(), pair.token1(), address(pair));

        d = DeployLib.deploy(
            Externals({
                reserve: address(gme),
                pair: address(pair),
                router: address(router),
                v2Factory: address(v2Factory),
                v3Factory: address(v3Factory),
                yieldVault: address(desk),
                guardian: teamWallet,
                teamWallet: teamWallet,
                tokenName: "Moass Fund",
                tokenSymbol: "MOASS"
            })
        );

        moass = MOASS(d.moass);
        sMoass = StakedMOASS(d.sMoass);
        staking = Staking(d.staking);
        treasury = Treasury(d.treasury);
        depo = BondDepository(d.bondDepository);
        oracle = PairOracle(d.oracle);
        genesis = GenesisBond(d.genesisBond);

        desk.wire(d.treasury);

        assertEq(d.moass, predictedMoass, "pair built against the right token");
        assertEq(desk.treasury(), d.treasury, "desk bound to the right treasury");
    }

    // ── The swap itself ──

    function test_theProtocolDeploysAgainstAnEighteenDecimalReserve() public view {
        assertEq(MockERC20(d.reserve).decimals(), 18, "GME, not a 6-decimal stablecoin");
        assertEq(moass.decimals(), 9, "MOASS keeps the OHM convention");
        assertTrue(treasury.wired());
    }

    function test_reserveScalingIsCorrectForEighteenDecimals() public {
        gme.mint(address(treasury), 1_000e18);
        // 10^(18 − 18) = 1, so raw GME is already WAD.
        assertEq(treasury.liquidUsdg(), 1_000e18, "no rescaling needed for an 18-decimal reserve");
    }

    function test_oracleScalingIsCorrectForEighteenDecimals() public view {
        // 10^(18 + 9 − 18): MOASS is 9 decimals, the quote asset 18.
        assertEq(oracle.priceScale(), 1e9);
    }

    function test_backingIsDenominatedInGmeNotDollars() public {
        gme.mint(address(treasury), 1_000e18);
        // 500 MOASS against 1,000 GME of reserves.
        vm.prank(d.distributor);
        treasury.mintMoass(alice, 500e9);

        assertEq(treasury.backingPerToken(), 2e18, "2 GME per MOASS, not $2");
    }

    // ── Launch, in GME ──

    function test_genesisRaisesGmeAndSeedsTheGmePool() public {
        uint256 raised = _raiseMinimum();
        genesis.finalize();

        uint256 toTreasury = raised * Constants.TREASURY_SPLIT_BPS / Constants.BPS;
        assertEq(gme.balanceOf(address(treasury)), toTreasury, "70% of the GME raise into reserves");
        assertEq(gme.balanceOf(address(pair)), raised - toTreasury, "30% seeds MOASS/GME");
        assertGt(pair.balanceOf(address(treasury)), 0, "the LP is protocol-owned");
    }

    function test_genesisPriceIsDenominatedInGme() public {
        _raiseMinimum();
        genesis.finalize();

        // GENESIS_PRICE_WAD = 3 means three GME per MOASS, roughly $70 at a
        // $23 GME. This is a parameter for the team, not a bug: it sets how
        // expensive one MOASS is at launch.
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 moassR, uint256 gmeR) =
            pair.token0() == address(moass) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        assertApproxEqRel(gmeR * 1e9 / moassR, 3e18, 0.001e18, "3 GME per MOASS");
    }

    // ── The desk in the vault slot ──

    function test_treasuryDeploysReservesIntoTheDeskUnderTheCap() public {
        _raiseMinimum();
        genesis.finalize();

        uint256 liquid = gme.balanceOf(address(treasury));
        uint256 quarter = liquid / 4;

        treasury.rebalanceToMorpho(quarter);

        assertEq(desk.totalAssets(), quarter, "the desk holds what the treasury sent");
        assertEq(treasury.morphoAssets(), quarter, "and the treasury still counts it");
    }

    function test_treasuryCapStillBindsTheLeveragedSleeve() public {
        _raiseMinimum();
        genesis.finalize();

        uint256 liquid = gme.balanceOf(address(treasury));

        vm.expectRevert(Treasury.MorphoCapExceeded.selector);
        treasury.rebalanceToMorpho(liquid * 71 / 100);

        treasury.rebalanceToMorpho(liquid * 70 / 100);
    }

    function test_openingAPositionDoesNotMoveBacking() public {
        _raiseMinimum();
        genesis.finalize();
        uint256 deployed = _deployToDesk();

        uint256 backingBefore = treasury.backingPerToken();

        vm.prank(teamWallet);
        desk.openPosition(venue, deployed, deployed * 3, 23.34e18, deployed * 2 * 2334 / 100);

        assertEq(treasury.backingPerToken(), backingBefore, "cost accounting: no mark-to-market");
    }

    function test_aWinningPositionRaisesBackingOnlyWhenSettled() public {
        _raiseMinimum();
        genesis.finalize();
        uint256 deployed = _deployToDesk();

        vm.prank(teamWallet);
        desk.openPosition(venue, deployed, deployed * 3, 23.34e18, deployed * 2 * 2334 / 100);

        uint256 backingWhileOpen = treasury.backingPerToken();

        // The venue pays back the collateral plus a 3x gain on a 10% move.
        uint256 profit = deployed * 30 / 100;
        gme.mint(venue, profit);
        vm.prank(venue);
        gme.transfer(address(desk), deployed + profit);

        vm.prank(teamWallet);
        desk.settlePosition();

        assertGt(treasury.backingPerToken(), backingWhileOpen, "the gain lands on settlement");
    }

    /// @dev The risk the UI has to state plainly: a liquidated sleeve takes the
    ///      whole committed portion of reserves with it, and backing falls by
    ///      that much. This is not a floor in the OHM sense.
    function test_aLiquidatedSleeveCutsBackingImmediately() public {
        _raiseMinimum();
        genesis.finalize();
        uint256 deployed = _deployToDesk();

        vm.prank(teamWallet);
        desk.openPosition(venue, deployed, deployed * 3, 23.34e18, deployed * 2 * 2334 / 100);

        uint256 backingBefore = treasury.backingPerToken();

        // Wiped out: the venue returns nothing.
        vm.prank(teamWallet);
        desk.settlePosition();

        uint256 backingAfter = treasury.backingPerToken();
        assertLt(backingAfter, backingBefore, "backing fell with the position");
        assertEq(desk.totalAssets(), 0);
        assertGt(backingAfter, 0, "the untouched liquid reserves survive");
    }

    function test_theDeskCannotBeDrainedToAnArbitraryAddress() public {
        _raiseMinimum();
        genesis.finalize();
        _deployToDesk();

        address attacker = makeAddr("attacker");
        vm.startPrank(teamWallet);
        vm.expectRevert(GmeDesk.UnknownVenue.selector);
        desk.openPosition(attacker, 1e18, 3e18, 1e18, 1e18);
        vm.stopPrank();

        assertEq(gme.balanceOf(attacker), 0);
    }

    // ── Bonds and emissions still work against GME ──

    function test_bondingGmeMintsMoassAndIsAccretive() public {
        _raiseMinimum();
        genesis.finalize();
        _matureOracle();

        gme.mint(bob, 100e18);
        vm.startPrank(bob);
        gme.approve(address(depo), type(uint256).max);

        uint256 backingBefore = treasury.backingPerToken();
        (, uint256 payout) = depo.deposit(0, 1e18, type(uint256).max, bob);
        vm.stopPrank();

        assertGt(payout, 0, "bonding GME pays MOASS");
        assertGe(treasury.backingPerToken(), backingBefore, "and never dilutes the floor");
    }

    function test_stakingAndRebasingWorkUnchanged() public {
        _raiseMinimum();
        genesis.finalize();
        skip(Constants.GENESIS_VEST);
        vm.prank(alice);
        genesis.claim();

        uint256 held = moass.balanceOf(alice);
        vm.startPrank(alice);
        moass.approve(address(staking), type(uint256).max);
        staking.stake(alice, held);
        vm.stopPrank();

        assertEq(sMoass.balanceOf(alice), held, "1:1 regardless of the reserve asset");

        _matureOracle();
        uint256 before = sMoass.balanceOf(alice);
        _advanceEpochs(3);
        assertGt(sMoass.balanceOf(alice), before, "rebases land");
    }

    // ── Helpers ──

    function _raiseMinimum() internal returns (uint256 raised) {
        uint256 needed = Constants.GENESIS_MIN_RAISE_WAD;
        uint256 wallets = (needed + WALLET_CAP - 1) / WALLET_CAP;

        for (uint256 i = 0; i < wallets; i++) {
            address buyer = i == 0 ? alice : (i == 1 ? bob : makeAddr(string(abi.encode("buyer", i))));
            uint256 amount = i == wallets - 1 ? needed - raised : WALLET_CAP;
            gme.mint(buyer, amount);
            vm.startPrank(buyer);
            gme.approve(address(genesis), type(uint256).max);
            genesis.purchase(amount);
            vm.stopPrank();
            raised += amount;
        }
        skip(Constants.GENESIS_DEADLINE + 1);
    }

    function _deployToDesk() internal returns (uint256 amount) {
        amount = gme.balanceOf(address(treasury)) / 2;
        treasury.rebalanceToMorpho(amount);
    }

    function _matureOracle() internal {
        oracle.checkpoint();
        _advanceWithKeeper(Constants.TWAP_MIN_WINDOW);
    }

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
