// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployLib, Deployment, Externals} from "../script/Deploy.s.sol";
import {MOASS} from "../src/MOASS.sol";
import {Treasury} from "../src/Treasury.sol";
import {BondDepository} from "../src/BondDepository.sol";
import {PairOracle} from "../src/PairOracle.sol";
import {GenesisBond} from "../src/GenesisBond.sol";
import {Staking} from "../src/Staking.sol";
import {GmeDesk} from "../src/GmeDesk.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20Metadata} from "../src/interfaces/external/IERC20.sol";
import {IUniswapV2Factory, IUniswapV2Pair} from "../src/interfaces/external/IUniswapV2.sol";

interface IV3Pool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function token0() external view returns (address);
}

/// @notice The protocol deployed against the REAL contracts on Robinhood Chain.
///
/// The unit suites use mocks with convenient decimals. This one uses the actual
/// tokenised GME (18 decimals), the actual USDG (6), and the actual Uniswap V2
/// factory, so the decimal handling that the reserve swap depends on is proven
/// against live code rather than against something I wrote to agree with me.
///
/// Requires network access. Skipped automatically when the RPC is unreachable,
/// so an offline `forge test` still passes.
contract ForkRobinhoodTest is Test {
    /// Real addresses, confirmed on chain 4663 on 2026-09-21.
    address internal constant GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant V2_FACTORY = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address internal constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant V2_ROUTER = 0x89e5DB8B5aA49aA85AC63f691524311AEB649eba;
    /// The deep GME/USDG market is a V3 pool at the 1% tier, not a V2 pair.
    address internal constant GME_USDG_V3 = 0xE9713f453aDB9245B19559790c96F470a18F2fDF;

    bool internal forked;

    Deployment internal d;
    MOASS internal moass;
    Treasury internal treasury;
    BondDepository internal depo;
    PairOracle internal oracle;
    GenesisBond internal genesis;
    Staking internal staking;
    GmeDesk internal desk;
    IUniswapV2Pair internal pair;

    address internal teamWallet;
    address internal alice;

    function setUp() public {
        try vm.createSelectFork("robinhood") {
            forked = true;
        } catch {
            return; // offline: every test below no-ops
        }

        teamWallet = makeAddr("teamMultisig");
        alice = makeAddr("alice");

        // Uniswap V2's createPair only records addresses, so the pair can be
        // created against MOASS before MOASS is deployed — which is exactly the
        // ordering a real launch needs.
        uint256 n = vm.getNonce(address(this));
        // desk at n, then DeployLib deploys MOASS first, at n+1.
        address predictedMoass = vm.computeCreateAddress(address(this), n + 1);

        address[] memory venues = new address[](1);
        venues[0] = teamWallet;
        desk = new GmeDesk(GME, teamWallet, venues, "Moass Fund GME Desk", "mGME");

        address pairAddress = IUniswapV2Factory(V2_FACTORY).createPair(predictedMoass, GME);
        pair = IUniswapV2Pair(pairAddress);

        d = DeployLib.deploy(
            Externals({
                reserve: GME,
                pair: pairAddress,
                router: V2_ROUTER,
                v2Factory: V2_FACTORY,
                v3Factory: V3_FACTORY,
                yieldVault: address(desk),
                guardian: teamWallet,
                teamWallet: teamWallet,
                tokenName: "Moass Fund",
                tokenSymbol: "MOASS"
            })
        );

        moass = MOASS(d.moass);
        treasury = Treasury(d.treasury);
        depo = BondDepository(d.bondDepository);
        oracle = PairOracle(d.oracle);
        genesis = GenesisBond(d.genesisBond);
        staking = Staking(d.staking);

        desk.wire(d.treasury);
        assertEq(d.moass, predictedMoass, "pair created against the right token");
    }

    modifier onlyForked() {
        if (!forked) return;
        _;
    }

    // ── The real assets ──

    function test_theRealGmeIsEighteenDecimals() public onlyForked {
        assertEq(IERC20Metadata(GME).decimals(), 18);
        assertEq(IERC20Metadata(GME).symbol(), "GME");
        assertEq(IERC20Metadata(USDG).decimals(), 6, "USDG really is 6 decimals");
    }

    function test_reserveScalingAgainstTheRealToken() public onlyForked {
        deal(GME, address(treasury), 1_000e18);
        // 10^(18 − 18) = 1: an 18-decimal reserve needs no rescaling.
        assertEq(treasury.liquidUsdg(), 1_000e18);
    }

    function test_oracleScalingAgainstTheRealToken() public onlyForked {
        // 10^(18 + 9 − 18): 9-decimal MOASS quoted in an 18-decimal asset.
        assertEq(oracle.priceScale(), 1e9);
    }

    /// @dev The same derivation the front end does in `gmeUsd()`. If this drifts
    ///      from reality, every dollar figure in the UI is wrong.
    function test_gmePriceFromTheV3PoolIsSane() public onlyForked {
        (uint160 sqrtPriceX96,,,,,,) = IV3Pool(GME_USDG_V3).slot0();
        address token0 = IV3Pool(GME_USDG_V3).token0();
        assertEq(token0, GME, "GME is token0 of that pool");

        // price(token1/token0) = (sqrtPriceX96 / 2^96)^2, then bridge 18 -> 6.
        uint256 rawScaled = (uint256(sqrtPriceX96) * uint256(sqrtPriceX96) * 1e18) >> 192;
        uint256 usdPerGme = rawScaled * 10 ** (18 - 6) / 1e18;

        assertGt(usdPerGme, 1, "GME is worth more than a dollar");
        assertLt(usdPerGme, 1_000, "and less than a thousand");
    }

    // ── The real DEX ──

    function test_theCanonicalPairIsARealUniswapV2Pair() public onlyForked {
        assertEq(IUniswapV2Factory(V2_FACTORY).getPair(d.moass, GME), address(pair));
        address t0 = pair.token0();
        address t1 = pair.token1();
        assertTrue(
            (t0 == d.moass && t1 == GME) || (t0 == GME && t1 == d.moass),
            "the pair really holds MOASS and GME"
        );
    }

    function test_taxRegistrationValidatesAgainstTheRealFactory() public onlyForked {
        _launch();
        // enableTax registered the canonical pair through the real factory.
        assertTrue(moass.isTaxedPair(address(pair)));
        assertEq(moass.taxTotalBps(), 500);
    }

    // ── A real launch ──

    function test_genesisRunsAgainstTheRealGme() public onlyForked {
        uint256 raised = _launch();

        uint256 toTreasury = raised * Constants.TREASURY_SPLIT_BPS / Constants.BPS;
        assertEq(IERC20Metadata(GME).balanceOf(address(treasury)), toTreasury);
        assertGt(pair.balanceOf(address(treasury)), 0, "protocol-owned liquidity in a real pool");
        assertGt(moass.totalSupply(), 0);
        assertTrue(staking.enabled());
    }

    function test_backingIsGmePerMoassAgainstRealAssets() public onlyForked {
        _launch();

        uint256 backing = treasury.backingPerToken();
        assertGt(backing, 0);
        // Denominated in GME. At a genesis price of 3 GME per MOASS with a
        // 70/30 split, backing lands comfortably under the price.
        assertLt(backing, 3e18, "backing is below the launch price, as it should be");
    }

    function test_theDeskTakesRealGmeUnderTheCap() public onlyForked {
        _launch();

        uint256 liquid = IERC20Metadata(GME).balanceOf(address(treasury));
        treasury.rebalanceToMorpho(liquid / 2);

        assertEq(desk.totalAssets(), liquid / 2, "real GME sitting in the desk");
        assertEq(treasury.morphoAssets(), liquid / 2);
    }

    function test_bondingRealGmeWorks() public onlyForked {
        _launch();
        _matureOracle();

        deal(GME, alice, 100e18);
        vm.startPrank(alice);
        IERC20Metadata(GME).approve(address(depo), type(uint256).max);

        uint256 backingBefore = treasury.backingPerToken();
        (, uint256 payout) = depo.deposit(0, 1e18, type(uint256).max, alice);
        vm.stopPrank();

        assertGt(payout, 0, "one real GME buys some MOASS");
        assertGe(treasury.backingPerToken(), backingBefore);
    }

    // ── Helpers ──

    function _launch() internal returns (uint256 raised) {
        uint256 needed = Constants.GENESIS_MIN_RAISE_WAD; // GME, 18 decimals
        uint256 perWallet = Constants.GENESIS_WALLET_CAP_WAD;
        uint256 wallets = (needed + perWallet - 1) / perWallet;

        for (uint256 i = 0; i < wallets; i++) {
            address buyer = i == 0 ? alice : address(uint160(0xB0B0000 + i));
            uint256 amount = i == wallets - 1 ? needed - raised : perWallet;
            deal(GME, buyer, amount);
            vm.startPrank(buyer);
            IERC20Metadata(GME).approve(address(genesis), type(uint256).max);
            genesis.purchase(amount);
            vm.stopPrank();
            raised += amount;
        }

        skip(Constants.GENESIS_DEADLINE + 1);
        genesis.finalize();
    }

    function _matureOracle() internal {
        oracle.checkpoint();
        uint256 remaining = Constants.TWAP_MIN_WINDOW;
        while (remaining > 0) {
            uint256 step = remaining < Constants.CHECKPOINT_MIN_INTERVAL
                ? remaining
                : Constants.CHECKPOINT_MIN_INTERVAL;
            skip(step);
            oracle.checkpoint();
            remaining -= step;
        }
    }
}
