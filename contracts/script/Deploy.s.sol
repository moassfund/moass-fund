// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {MOASS} from "../src/MOASS.sol";
import {StakedMOASS} from "../src/StakedMOASS.sol";
import {Staking} from "../src/Staking.sol";
import {Distributor} from "../src/Distributor.sol";
import {Treasury} from "../src/Treasury.sol";
import {BondDepository} from "../src/BondDepository.sol";
import {PairOracle} from "../src/PairOracle.sol";
import {TaxCollector} from "../src/TaxCollector.sol";
import {GenesisBond} from "../src/GenesisBond.sol";
import {InverseBond} from "../src/InverseBond.sol";
import {PremiumSeller} from "../src/PremiumSeller.sol";
import {PTeam} from "../src/PTeam.sol";
import {ShareCertificate} from "../src/ShareCertificate.sol";
import {Constants} from "../src/Constants.sol";

/// @notice Every address the protocol consists of, in one struct.
/// @dev Field names match `CONTRACTS` in `src/protocol/chainAdapter.ts`, so the
///      deploy output can be pasted straight into the front end.
struct Deployment {
    address moass;
    address sMoass;
    address staking;
    address distributor;
    address treasury;
    address bondDepository;
    address oracle;
    address taxCollector;
    address genesisBond;
    address inverseBond;
    address premiumSeller;
    address pTeam;
    address certificate;
    address pair;
    address reserve;
}

/// @notice External addresses the protocol is deployed against.
struct Externals {
    /// @dev The reserve asset. USDG upstream; GME for Moass Fund.
    address reserve;
    /// @dev The canonical MOASS/reserve Uniswap V2 pair. Must already exist.
    address pair;
    address router;
    address v2Factory;
    address v3Factory;
    /// @dev ERC-4626 vault the treasury may deploy idle reserves into.
    address yieldVault;
    address guardian;
    address teamWallet;
    /// @dev Token branding, set once at construction. A deployment carries its
    ///      own name so a test launch never squats the real ticker.
    string tokenName;
    string tokenSymbol;
}

/// @title DeployLib — constructs and wires the whole protocol in one call.
/// @dev The ordering is forced by the constructor/wire dependency graph, and
///      `Wired` makes every `wire()` callable exactly once by the deployer.
///      That means this must all happen from a single address, and after it
///      there is no address-mutation surface left anywhere in the system.
///
///      Tests call this so the deployment itself is exercised, rather than a
///      hand-rolled approximation that might wire something the real script
///      does not.
library DeployLib {
    /// @dev Split into construct/wire, and addresses are written straight into
    ///      the struct rather than held in locals: the whole thing in one
    ///      function overflows the EVM stack.
    function deploy(Externals memory ext) internal returns (Deployment memory d) {
        d = _construct(ext);
        _wire(d, ext);
    }

    function _construct(Externals memory ext) private returns (Deployment memory d) {
        d.reserve = ext.reserve;
        d.pair = ext.pair;

        // Tokens and staking. sMOASS's entire inventory is assigned to Staking
        // at wiring, so Staking must exist first.
        d.moass = address(new MOASS(ext.guardian, ext.tokenName, ext.tokenSymbol));
        d.sMoass = address(
            new StakedMOASS(
                string.concat("Staked ", ext.tokenSymbol), string.concat("s", ext.tokenSymbol)
            )
        );
        d.staking = address(new Staking(d.moass, d.sMoass, Constants.STAKING_WARMUP_EPOCHS));

        // Pricing and custody.
        d.oracle = address(new PairOracle(ext.pair, d.moass, ext.reserve));
        d.treasury = address(new Treasury(d.moass, ext.reserve, ext.yieldVault, ext.pair));

        // Emissions and primary markets.
        d.distributor =
            address(new Distributor(d.treasury, d.moass, d.sMoass, d.staking, d.oracle));
        d.bondDepository =
            address(new BondDepository(d.moass, ext.reserve, ext.pair, d.oracle, d.treasury));

        // Secondary-market machinery and the launch.
        d.taxCollector = address(
            new TaxCollector(
                d.moass, ext.reserve, ext.router, ext.pair, d.oracle, d.treasury, ext.teamWallet
            )
        );
        d.genesisBond = address(
            new GenesisBond(d.moass, ext.reserve, d.treasury, d.staking, ext.pair, d.oracle)
        );
        d.certificate = address(
            new ShareCertificate(
                d.genesisBond,
                string.concat(ext.tokenName, " Founding Shareholder Certificate"),
                string.concat(ext.tokenSymbol, "-FS")
            )
        );
        d.pTeam = address(new PTeam(d.moass, ext.reserve, d.treasury, ext.teamWallet));
        d.inverseBond =
            address(new InverseBond(d.moass, ext.reserve, d.treasury, d.oracle, d.genesisBond));
        d.premiumSeller = address(
            new PremiumSeller(
                d.moass, ext.reserve, ext.router, ext.pair, d.treasury, d.oracle, d.genesisBond
            )
        );
    }

    /// @dev Every call here is single-use and freezes afterwards, so this must
    ///      run from the same address that constructed the contracts. Once it
    ///      returns, no address in the system can ever be changed again.
    function _wire(Deployment memory d, Externals memory ext) private {
        StakedMOASS(d.sMoass).wire(d.staking);
        Staking(d.staking).wire(d.distributor, d.oracle, d.genesisBond);
        BondDepository(d.bondDepository).wire(d.genesisBond);
        GenesisBond(d.genesisBond).wire(d.bondDepository, d.certificate);
        TaxCollector(d.taxCollector).wire(d.pTeam);

        // The minter set is fixed forever here: everything that may create
        // MOASS, and nothing else. Note the deployer is not on it.
        address[] memory minters = new address[](5);
        minters[0] = d.distributor;
        minters[1] = d.genesisBond;
        minters[2] = d.bondDepository;
        minters[3] = d.premiumSeller;
        minters[4] = d.pTeam;
        address[] memory spenders = new address[](1);
        spenders[0] = d.inverseBond;
        Treasury(d.treasury).wire(minters, spenders);

        // Protocol contracts hold MOASS in the ordinary course of business and
        // must not be taxed for it. The pair itself is never exemptible.
        address[] memory exempt = new address[](6);
        exempt[0] = d.treasury;
        exempt[1] = d.staking;
        exempt[2] = d.bondDepository;
        exempt[3] = d.genesisBond;
        exempt[4] = d.inverseBond;
        exempt[5] = d.premiumSeller;
        MOASS(d.moass).wire(
            d.treasury,
            d.taxCollector,
            d.genesisBond,
            ext.v2Factory,
            ext.v3Factory,
            exempt,
            new address[](0)
        );

        // MOASS held by these never counts as float for the pTEAM cap.
        address[] memory excludedFromFloat = new address[](5);
        excludedFromFloat[0] = d.treasury;
        excludedFromFloat[1] = d.inverseBond;
        excludedFromFloat[2] = d.taxCollector;
        excludedFromFloat[3] = d.genesisBond;
        excludedFromFloat[4] = d.bondDepository;
        PTeam(d.pTeam).wire(d.genesisBond, excludedFromFloat);
    }
}
