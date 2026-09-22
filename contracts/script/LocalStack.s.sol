// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DeployLib, Deployment, Externals} from "./Deploy.s.sol";
import {GmeDesk} from "../src/GmeDesk.sol";
import {MockERC20, MockPair, MockRouter, MockV2Factory, MockV3Factory, MockV3Pool} from "../test/mocks/Mocks.sol";

/// @title LocalStack — the whole protocol on a throwaway chain, in one call.
///
/// Used by `npm start`. It deploys stand-ins for the assets and the DEX rather
/// than forking, which makes the stack instant, deterministic and usable with
/// no network at all. Compatibility with the real chain is proven separately by
/// `test/ForkRobinhood.t.sol`, which runs against live Robinhood Chain.
///
/// The stand-ins match the real thing where it matters: GME is 18 decimals,
/// USDG is 6, and the GME/USDG price feed is a V3 pool seeded with the live
/// `sqrtPriceX96`, so the dollar figures on screen are about right.
///
/// Genesis is NOT run here. It needs the sale deadline to pass, and time travel
/// only works through the node's RPC, so `scripts/start.mjs` drives that part.
contract LocalStack is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address teamWallet = vm.envOr("TEAM_WALLET", deployer);

        vm.startBroadcast(pk);

        // ── Stand-ins for what already exists on the real chain ──
        MockERC20 gme = new MockERC20("GameStop Robinhood Token", "GME", 18);
        MockERC20 usdg = new MockERC20("USDG", "USDG", 6);

        MockV2Factory v2Factory = new MockV2Factory();
        MockV3Factory v3Factory = new MockV3Factory();
        MockRouter router = new MockRouter(new MockERC20("unused", "X", 9), gme);
        MockV3Pool gmeUsdgPool = new MockV3Pool(address(gme), address(usdg), 10_000);

        address[] memory venues = new address[](1);
        venues[0] = teamWallet;
        GmeDesk desk = new GmeDesk(
            address(gme),
            teamWallet,
            venues,
            string.concat(vm.envOr("TOKEN_NAME", string("Moass Fund")), " GME Desk"),
            "mGME"
        );

        // The pair must exist before the protocol is built against it, and it
        // needs MOASS's address. Predicted, then asserted after deployment so a
        // wrong guess aborts instead of half-wiring anything.
        address predictedMoass = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        MockPair pair = new MockPair(predictedMoass, address(gme));

        Deployment memory d = DeployLib.deploy(
            Externals({
                reserve: address(gme),
                pair: address(pair),
                router: address(router),
                v2Factory: address(v2Factory),
                v3Factory: address(v3Factory),
                yieldVault: address(desk),
                guardian: teamWallet,
                teamWallet: teamWallet,
                tokenName: vm.envOr("TOKEN_NAME", string("Moass Fund")),
                tokenSymbol: vm.envOr("TOKEN_SYMBOL", string("MOASS"))
            })
        );
        require(d.moass == predictedMoass, "MOASS address prediction failed");

        desk.wire(d.treasury);
        v2Factory.setPair(pair.token0(), pair.token1(), address(pair));

        vm.stopBroadcast();

        _write(d, address(desk), address(gme), address(usdg), address(gmeUsdgPool));
    }

    function _write(Deployment memory d, address desk, address gme, address usdg, address pool)
        internal
    {
        string memory k = "deployment";
        vm.serializeAddress(k, "moass", d.moass);
        vm.serializeAddress(k, "sMoass", d.sMoass);
        vm.serializeAddress(k, "staking", d.staking);
        vm.serializeAddress(k, "distributor", d.distributor);
        vm.serializeAddress(k, "treasury", d.treasury);
        vm.serializeAddress(k, "bondDepository", d.bondDepository);
        vm.serializeAddress(k, "oracle", d.oracle);
        vm.serializeAddress(k, "taxCollector", d.taxCollector);
        vm.serializeAddress(k, "genesisBond", d.genesisBond);
        vm.serializeAddress(k, "inverseBond", d.inverseBond);
        vm.serializeAddress(k, "premiumSeller", d.premiumSeller);
        vm.serializeAddress(k, "pTeam", d.pTeam);
        vm.serializeAddress(k, "certificate", d.certificate);
        vm.serializeAddress(k, "gmeDesk", desk);
        vm.serializeAddress(k, "pair", d.pair);
        vm.serializeAddress(k, "gme", gme);
        vm.serializeAddress(k, "usdg", usdg);
        string memory out = vm.serializeAddress(k, "gmeUsdgPool", pool);

        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console.log("wrote contracts/%s", path);
    }
}
