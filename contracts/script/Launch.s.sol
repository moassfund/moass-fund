// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DeployLib, Deployment, Externals} from "./Deploy.s.sol";
import {GmeDesk} from "../src/GmeDesk.sol";
import {IUniswapV2Factory} from "../src/interfaces/external/IUniswapV2.sol";

/// @title Launch — deploys Moass Fund and prints the front end's configuration.
///
/// Usage (dry run first, always):
///
///   forge script script/Launch.s.sol --rpc-url robinhood
///   forge script script/Launch.s.sol --rpc-url robinhood --broadcast --verify
///
/// Required environment:
///   PRIVATE_KEY      deployer. Must be the ONLY account used, because every
///                    `wire()` is restricted to whoever constructed the
///                    contract and can be called exactly once.
///   RESERVE          the reserve asset (tokenised GME on Robinhood Chain).
///   V2_FACTORY       Uniswap V2 factory, used to create the MOASS/reserve pair.
///   V2_ROUTER        Uniswap V2 router, used by the tax collector.
///   V3_FACTORY       Uniswap V3 factory, used to validate taxed pools.
///   GUARDIAN         multisig that may register taxed pairs and exemptions.
///   TEAM_WALLET      multisig that holds pTEAM and operates the desk.
///   DESK_VENUES      comma-free list is not supported; pass one address. The
///                    venue set is immutable, so it is deliberately explicit.
///
/// After a successful run, copy the printed block into `.env` and set
/// VITE_DATA_SOURCE=chain.
contract Launch is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        Externals memory ext = Externals({
            reserve: vm.envAddress("RESERVE"),
            pair: address(0), // created below
            router: vm.envAddress("V2_ROUTER"),
            v2Factory: vm.envAddress("V2_FACTORY"),
            v3Factory: vm.envAddress("V3_FACTORY"),
            yieldVault: address(0), // the desk, deployed below
            guardian: vm.envAddress("GUARDIAN"),
            teamWallet: vm.envAddress("TEAM_WALLET"),
            tokenName: vm.envOr("TOKEN_NAME", string("Moass Fund")),
            tokenSymbol: vm.envOr("TOKEN_SYMBOL", string("MOASS"))
        });

        address venue = vm.envAddress("DESK_VENUES");

        console.log("deployer     ", deployer);
        console.log("reserve      ", ext.reserve);
        console.log("v2 factory   ", ext.v2Factory);
        console.log("guardian     ", ext.guardian);
        console.log("team wallet  ", ext.teamWallet);

        vm.startBroadcast(pk);

        // 1. The desk. It learns its treasury afterwards through `wire`, so it
        //    can be built before anything else exists.
        address[] memory venues = new address[](1);
        venues[0] = venue;
        GmeDesk desk = new GmeDesk(
            ext.reserve, ext.teamWallet, venues, string.concat(ext.tokenName, " GME Desk"), "mGME"
        );
        ext.yieldVault = address(desk);

        // 2. The canonical pair. Uniswap's createPair only records addresses,
        //    so it can be created against a MOASS that does not exist yet —
        //    which is necessary, because the Treasury and the oracle take the
        //    pair as a constructor argument.
        //
        //    The prediction is asserted below: if it is wrong the whole
        //    deployment reverts rather than producing a protocol wired to the
        //    wrong pool.
        address predictedMoass = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        ext.pair = IUniswapV2Factory(ext.v2Factory).createPair(predictedMoass, ext.reserve);

        // 3. Everything else, in dependency order.
        Deployment memory d = DeployLib.deploy(ext);
        require(d.moass == predictedMoass, "MOASS address prediction failed; nothing is wired");

        // 4. Point the desk at the treasury it serves. Single-use, frozen after.
        desk.wire(d.treasury);

        vm.stopBroadcast();

        _write(d, address(desk), ext);
        _report(d, address(desk), ext);
    }

    /// @dev Same shape the local stack writes, so tooling reads one format.
    function _write(Deployment memory d, address desk, Externals memory ext) internal {
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
        vm.serializeAddress(k, "usdg", vm.envOr("USDG", address(0)));
        vm.serializeAddress(k, "gmeUsdgPool", vm.envOr("GME_USDG_POOL", address(0)));
        string memory out = vm.serializeAddress(k, "gme", ext.reserve);

        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console.log("wrote contracts/%s", path);
    }

    function _report(Deployment memory d, address desk, Externals memory ext) internal pure {
        console.log("");
        console.log("=== Deployed. Copy into .env, then set VITE_DATA_SOURCE=chain ===");
        console.log("");
        console.log("VITE_ADDR_MOASS=%s", d.moass);
        console.log("VITE_ADDR_SMOASS=%s", d.sMoass);
        console.log("VITE_ADDR_STAKING=%s", d.staking);
        console.log("VITE_ADDR_DISTRIBUTOR=%s", d.distributor);
        console.log("VITE_ADDR_TREASURY=%s", d.treasury);
        console.log("VITE_ADDR_BOND_DEPOSITORY=%s", d.bondDepository);
        console.log("VITE_ADDR_ORACLE=%s", d.oracle);
        console.log("VITE_ADDR_GME_DESK=%s", desk);
        console.log("VITE_ADDR_INVERSE_BOND=%s", d.inverseBond);
        console.log("VITE_ADDR_PAIR=%s", d.pair);
        console.log("VITE_ADDR_GME=%s", ext.reserve);
        console.log("");
        console.log("Not in .env but worth recording:");
        console.log("  taxCollector  %s", d.taxCollector);
        console.log("  genesisBond   %s", d.genesisBond);
        console.log("  premiumSeller %s", d.premiumSeller);
        console.log("  pTeam         %s", d.pTeam);
        console.log("  certificate   %s", d.certificate);
        console.log("");
        console.log("NEXT, in order:");
        console.log("  1. Run the sale: GenesisBond.purchase() until the cap or the deadline.");
        console.log("  2. GenesisBond.finalize() - this is the switch that turns everything on.");
        console.log("  3. Start the oracle keeper. Nothing works without it: a TWAP is only");
        console.log("     readable from an observation 30 min to 4 h old, so if checkpoint()");
        console.log("     is not called at least every 4 hours, emissions mint zero and bonds");
        console.log("     stop pricing. indexer/snapshot.mjs does this hourly.");
    }
}
