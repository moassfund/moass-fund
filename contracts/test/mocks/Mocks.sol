// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {IDistributor} from "../../src/interfaces/IDistributor.sol";
import {IPairOracle} from "../../src/interfaces/IPairOracle.sol";

/// @notice Minimal mintable ERC-20 with configurable decimals.
/// @dev Decimals are a constructor argument on purpose: the reserve swap turns a
///      6-decimal USDG into an 18-decimal GME, and that is exactly where unit
///      bugs will hide. Tests should be able to reproduce either.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function burn(address from, uint256 value) external {
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    /// @dev IMOASS-shaped burn: destroys the caller's own tokens.
    function burn(uint256 value) external {
        balanceOf[msg.sender] -= value;
        totalSupply -= value;
        emit Transfer(msg.sender, address(0), value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        return _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}

/// @notice Stands in for the real Distributor: mints a settable amount of MOASS
///         to Staking each epoch, the way `Treasury.mintMoass` would.
contract MockDistributor is IDistributor {
    MockERC20 public immutable moass;
    address public immutable staking;

    uint256 public perEpoch;
    uint256 public epochsDistributed;
    bool public reverting;

    constructor(MockERC20 moass_, address staking_) {
        moass = moass_;
        staking = staking_;
    }

    function setPerEpoch(uint256 amount) external {
        perEpoch = amount;
    }

    /// @dev Lets a test assert that a failing distributor takes the rebase with
    ///      it, rather than silently paying nothing.
    function setReverting(bool on) external {
        reverting = on;
    }

    function distribute() external returns (uint256 minted) {
        require(msg.sender == staking, "not staking");
        require(!reverting, "distributor down");
        minted = perEpoch;
        epochsDistributed += 1;
        if (minted > 0) moass.mint(staking, minted);
        emit Distributed(epochsDistributed, minted, 0);
    }

    function nextReward() external view returns (uint256) {
        return perEpoch;
    }

    function premium() external pure returns (uint256) {
        return 1e18;
    }

    function currentRateWad() external pure returns (uint256) {
        return 0;
    }

    function rMaxWad() external pure returns (uint256) {
        return 0.0045e18;
    }

    function kWad() external pure returns (uint256) {
        return 1.75e18;
    }
}

/// @notice Oracle stub. `checkpoint()` counts calls so tests can prove the
///         rebase keeps the oracle alive even when no keeper touches it.
contract MockOracle is IPairOracle {
    uint256 public checkpoints;
    uint256 public twap = 1e18;
    bool public stale;

    function setTwap(uint256 twap_) external {
        twap = twap_;
    }

    function setStale(bool on) external {
        stale = on;
    }

    function checkpoint() external {
        checkpoints += 1;
        emit Checkpointed(0, uint32(block.timestamp));
    }

    function twapMoassUsdg() external view returns (uint256) {
        require(!stale, "stale");
        return twap;
    }

    function pair() external pure returns (address) {
        return address(0);
    }

    function twapMinWindow() external pure returns (uint256) {
        return 30 minutes;
    }

    function twapMaxWindow() external pure returns (uint256) {
        return 4 hours;
    }
}

/// @notice Treasury stub exposing the two numbers the Distributor reads —
///         `rfv()` (the reserve floor that caps minting) and
///         `backingPerToken()` (the denominator of the premium) — plus the
///         mint hook. Both are settable so tests can walk the emissions curve.
contract MockTreasury {
    MockERC20 public immutable moass;
    address public immutable usdg;

    uint256 public rfv;
    uint256 public backingPerToken;
    mapping(address => bool) public isMinter;

    constructor(MockERC20 moass_, address usdg_) {
        moass = moass_;
        usdg = usdg_;
        backingPerToken = 1e18;
    }

    function setRfv(uint256 v) external {
        rfv = v;
    }

    function setBackingPerToken(uint256 v) external {
        backingPerToken = v;
    }

    function setMinter(address account, bool on) external {
        isMinter[account] = on;
    }

    function mintMoass(address to, uint256 amount) external {
        require(isMinter[msg.sender], "not minter");
        moass.mint(to, amount);
    }

    // ── Reserve spending (what InverseBond's buyback draws on) ──

    mapping(address => bool) public isSpender;

    function setSpender(address account, bool on) external {
        isSpender[account] = on;
    }

    /// @dev WAD, mirroring the real treasury's scaling of raw reserve units.
    function liquidUsdg() public view returns (uint256) {
        return MockERC20(usdg).balanceOf(address(this)) * 10 ** (18 - MockERC20(usdg).decimals());
    }

    function spendUsdg(address to, uint256 amountRaw) external {
        require(isSpender[msg.sender], "not spender");
        require(MockERC20(usdg).transfer(to, amountRaw), "transfer");
    }
}

/// @notice ERC-4626 vault stub (the Morpho USDG sleeve upstream, whatever the
///         GME desk becomes here). Shares are 1:1 with assets until a test calls
///         `accrue()`, which simulates yield and makes convertToAssets diverge.
contract MockERC4626 {
    MockERC20 public immutable assetToken;

    uint256 public totalShares;
    uint256 public totalAssets;
    mapping(address => uint256) public balanceOf;

    constructor(MockERC20 asset_) {
        assetToken = asset_;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    /// @dev Credits yield to existing shareholders without issuing shares.
    function accrue(uint256 assets) external {
        assetToken.mint(address(this), assets);
        totalAssets += assets;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return totalAssets == 0 ? assets : assets * totalShares / totalAssets;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return totalShares == 0 ? shares : shares * totalAssets / totalShares;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        require(assetToken.transferFrom(msg.sender, address(this), assets), "transferFrom");
        totalShares += shares;
        totalAssets += assets;
        balanceOf[receiver] += shares;
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        shares = convertToShares(assets);
        require(balanceOf[owner] >= shares, "shares");
        balanceOf[owner] -= shares;
        totalShares -= shares;
        totalAssets -= assets;
        require(assetToken.transfer(receiver, assets), "transfer");
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        assets = convertToAssets(shares);
        require(balanceOf[owner] >= shares, "shares");
        balanceOf[owner] -= shares;
        totalShares -= shares;
        totalAssets -= assets;
        require(assetToken.transfer(receiver, assets), "transfer");
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        return convertToAssets(balanceOf[owner]);
    }

    function previewWithdraw(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }
}

/// @notice Uniswap-V2-shaped pair with settable reserves and LP balances.
/// @dev Only the surface the Treasury and PairOracle read is implemented:
///      token ordering, reserves, LP supply and the cumulative price
///      accumulators the TWAP is built from.
contract MockPair {
    address public immutable token0;
    address public immutable token1;

    uint112 private r0;
    uint112 private r1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address tokenA, address tokenB) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function setReserves(uint112 reserve0, uint112 reserve1) external {
        _accumulate();
        r0 = reserve0;
        r1 = reserve1;
    }

    function mintLp(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, blockTimestampLast);
    }

    /// @dev UQ112x112 accumulation, as the real pair does on each touch.
    function _accumulate() internal {
        uint32 nowTs = uint32(block.timestamp % 2 ** 32);
        uint32 elapsed = nowTs - blockTimestampLast;
        if (elapsed > 0 && r0 != 0 && r1 != 0) {
            price0CumulativeLast += (uint256(r1) << 112) / r0 * elapsed;
            price1CumulativeLast += (uint256(r0) << 112) / r1 * elapsed;
        }
        blockTimestampLast = nowTs;
    }

    function sync() external {
        _accumulate();
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max && from != msg.sender) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    /// @dev Real Uniswap-V2-style mint for integration tests: reads the tokens
    ///      actually sitting in the pair, issues LP for the difference, and
    ///      syncs reserves. Unit tests that only need numbers keep using
    ///      `setReserves` and never call this.
    function mint(address to) external returns (uint256 liquidity) {
        uint256 bal0 = MockERC20(token0).balanceOf(address(this));
        uint256 bal1 = MockERC20(token1).balanceOf(address(this));
        uint256 amount0 = bal0 - r0;
        uint256 amount1 = bal1 - r1;

        if (totalSupply == 0) {
            liquidity = _sqrt(amount0 * amount1) - 1000; // MINIMUM_LIQUIDITY
            totalSupply += 1000;
            balanceOf[address(0xdead)] += 1000;
        } else {
            uint256 a = amount0 * totalSupply / r0;
            uint256 b = amount1 * totalSupply / r1;
            liquidity = a < b ? a : b;
        }
        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED");
        totalSupply += liquidity;
        balanceOf[to] += liquidity;

        _accumulate();
        r0 = uint112(bal0);
        r1 = uint112(bal1);
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function factory() external view returns (address) {
        return address(this);
    }
}

/// @notice Uniswap V2 factory stub. `MOASS.addTaxedPair` validates a submitted
///         pool against the canonical factory, so tests need one that can both
///         confirm and deny a pair.
contract MockV2Factory {
    mapping(address => mapping(address => address)) internal _pairs;

    function setPair(address tokenA, address tokenB, address pair) external {
        _pairs[tokenA][tokenB] = pair;
        _pairs[tokenB][tokenA] = pair;
    }

    function getPair(address tokenA, address tokenB) external view returns (address) {
        return _pairs[tokenA][tokenB];
    }

    function createPair(address, address) external pure returns (address) {
        return address(0);
    }
}

/// @notice Uniswap V3 factory stub, fee-tier aware.
contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) internal _pools;

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        _pools[tokenA][tokenB][fee] = pool;
        _pools[tokenB][tokenA][fee] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return _pools[tokenA][tokenB][fee];
    }
}

/// @notice Uniswap V2 router stub. Swaps MOASS for USDG at a settable rate so
///         tests can produce a good fill, a bad fill, or a fee-on-transfer one.
contract MockRouter {
    MockERC20 public immutable moass;
    MockERC20 public immutable usdg;

    /// @dev WAD USDG per whole (9-decimal) MOASS. Defaults to $1.
    uint256 public rateWad = 1e18;

    constructor(MockERC20 moass_, MockERC20 usdg_) {
        moass = moass_;
        usdg = usdg_;
    }

    function setRate(uint256 rateWad_) external {
        rateWad = rateWad_;
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        require(path.length == 2, "path");
        require(moass.transferFrom(msg.sender, address(this), amountIn), "pull");
        // amountIn is 9-decimal MOASS; out is 6-decimal USDG.
        uint256 out = amountIn * rateWad / 1e9 / 1e12;
        require(out >= amountOutMin, "MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
        usdg.mint(to, out);
    }

    function addLiquidity(address, address, uint256, uint256, uint256, uint256, address, uint256)
        external
        pure
        returns (uint256, uint256, uint256)
    {
        return (0, 0, 0);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata)
        external
        view
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn * rateWad / 1e9 / 1e12;
    }
}

/// @notice pTEAM stub: the single clock that drives the tax split decay.
contract MockPTeam {
    uint256 public vestedFraction; // WAD

    function setVestedFraction(uint256 v) external {
        vestedFraction = v;
    }
}

/// @notice GenesisBond stub. The only thing the rest of the protocol reads from
///         it is `finalizeTime()`: zero means the launch has not completed and
///         the buyback is dormant.
contract MockGenesisBond {
    uint64 public finalizeTime;

    function setFinalizeTime(uint64 t) external {
        finalizeTime = t;
    }
}

/// @notice Uniswap V3 pool stub, enough for the price read the front end does.
/// @dev On Robinhood Chain the deep GME/USDG market is a V3 pool, so the local
///      stack needs one to put a dollar figure on a GME-denominated protocol.
///      The default price is the real one: sqrtPriceX96 taken from the live
///      1% pool, which works out to about $23.34 per GME.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    uint160 public sqrtPriceX96 = 382726753889303376201106;

    constructor(address token0_, address token1_, uint24 fee_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    function setSqrtPriceX96(uint160 v) external {
        sqrtPriceX96 = v;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 1, 1, 0, true);
    }
}
