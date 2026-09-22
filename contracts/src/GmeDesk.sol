// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {IERC20, IERC20Metadata} from "./interfaces/external/IERC20.sol";
import {Constants} from "./Constants.sol";
import {Wired} from "./abstract/Wired.sol";

/// @title GmeDesk — the treasury's leveraged GME sleeve
/// @notice Moass Fund's replacement for NetNet's Morpho lending sleeve. The
///         Treasury sees an ERC-4626 vault and needs no changes: it deposits
///         idle reserves here under the same `MORPHO_CAP_BPS` ceiling and the
///         same `rebalanceToMorpho` / `rebalanceFromMorpho` entrypoints.
///
///         Where the upstream sleeve earned lending yield on a stablecoin, this
///         one holds GME and runs a leveraged long on it, operated by the team
///         multisig on whatever venue has liquidity at the time.
///
/// @dev ACCOUNTING IS AT COST, DELIBERATELY. `convertToAssets` reports liquid
///      GME plus the collateral still committed to an open position — never a
///      marked-to-market value. Two reasons:
///
///        1. No oracle is needed for backing, so backing cannot be moved by
///           manipulating a price feed. The most safety-critical number in the
///           protocol stays a function of balances only.
///        2. Unrealised profit never inflates backing, so it can never be
///           borrowed against or emitted against. Losses, by contrast, are
///           recognised the moment the manager settles.
///
///      The consequence is that backing UNDERSTATES the desk while a winning
///      position is open, and the UI's mark, PnL, liquidation price and health
///      are computed off-chain from the position facts stored here plus the
///      GME price the front end already fetches. That is the honest trade: the
///      number the protocol mints against is conservative, and the number the
///      user looks at is informative.
///
/// @dev TRUST MODEL. The manager is the team multisig and can move GME out to
///      a venue to run the position. Three limits are enforced in code:
///        - the venue set is IMMUTABLE, fixed at construction;
///        - withdrawals to the depositor can only go to the Treasury;
///        - the cap on how much of the treasury lands here is enforced by the
///          Treasury itself and cannot be raised from this side.
///      Within those, a compromised manager can lose the sleeve by trading it
///      badly. It cannot steal it to an arbitrary address, and it cannot touch
///      the treasury's liquid reserves. This is stated plainly in the UI.
contract GmeDesk is Wired {
    error NotManager();
    error NotTreasury();
    error TreasuryNotSet();
    error OnlyTreasuryMayReceive();
    error UnknownVenue();
    error PositionOpen();
    error NoPosition();
    error InsufficientLiquid();
    error ZeroAmount();
    error TransferFailed();
    error EmptyMetadata();

    event Deposited(uint256 assets, uint256 shares);
    event Withdrawn(uint256 assets, uint256 shares);
    event PositionOpened(
        address indexed venue, uint256 collateral, uint256 sizeUnits, uint256 entryPriceWad, uint256 debtQuoteWad
    );
    event PositionSettled(address indexed venue, uint256 collateral, uint256 returned, int256 pnl);
    event SentToVenue(address indexed venue, uint256 amount);

    /// @notice The reserve asset. GME for Moass Fund.
    IERC20 public immutable asset;
    /// @notice The only account that may deposit or receive withdrawals.
    /// @dev Set once by `wire`, then frozen. It cannot be an immutable because
    ///      the Treasury is constructed against this contract's address, so one
    ///      of the two has to learn about the other afterwards. Using the same
    ///      single-use wiring the rest of the protocol uses keeps the guarantee
    ///      identical: after deployment there is no way to repoint it.
    address public treasury;
    /// @notice The team multisig that operates the position.
    address public immutable manager;

    /// @dev Fixed at construction. GME may only ever leave the desk to one of
    ///      these, or back to the treasury.
    mapping(address => bool) public isVenue;
    address[] private _venues;

    // ── ERC-4626 share accounting ──

    /// @dev Set once at construction; composed from the deployment's branding.
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ── The position ──

    struct Position {
        address venue;
        /// @notice GME committed as collateral. This is what backing counts.
        uint256 collateral;
        /// @notice GME-equivalent units of exposure, i.e. collateral × leverage.
        uint256 sizeUnits;
        /// @notice Entry price of GME in the quote asset, WAD.
        uint256 entryPriceWad;
        /// @notice Quote-denominated borrowings against the position, WAD.
        uint256 debtQuoteWad;
        /// @dev Liquid GME held at the moment the position was last funded.
        ///      Settlement measures proceeds against this rather than against
        ///      the whole balance, so uncommitted reserves sitting in the desk
        ///      are never mistaken for trading profit.
        uint256 liquidAtOpen;
        uint64 openedAt;
    }

    Position public position;
    /// @notice Cumulative realised profit and loss, in GME.
    int256 public realisedPnl;

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }

    constructor(
        address asset_,
        address manager_,
        address[] memory venues_,
        string memory name_,
        string memory symbol_
    ) {
        if (asset_ == address(0) || manager_ == address(0)) revert ZeroAddress();
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0) revert EmptyMetadata();
        name = name_;
        symbol = symbol_;
        asset = IERC20(asset_);
        manager = manager_;
        decimals = IERC20Metadata(asset_).decimals();
        for (uint256 i = 0; i < venues_.length; i++) {
            if (venues_[i] == address(0)) revert ZeroAddress();
            isVenue[venues_[i]] = true;
            _venues.push(venues_[i]);
        }
    }

    /// @notice One-time wiring of the Treasury this desk serves. Frozen after.
    function wire(address treasury_) external wiring {
        treasury = _nonZero(treasury_);
    }

    // ── Valuation ──

    /// @notice GME sitting in the desk, unencumbered.
    function liquidAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// @notice GME committed to the open position, at cost.
    function deployedAssets() public view returns (uint256) {
        return position.collateral;
    }

    /// @notice Total GME the desk is accountable for: liquid plus committed,
    ///         at cost. Never marked to market — see the contract notice.
    function totalAssets() public view returns (uint256) {
        return liquidAssets() + deployedAssets();
    }

    function convertToShares(uint256 assets_) public view returns (uint256) {
        uint256 total = totalAssets();
        return total == 0 || totalSupply == 0 ? assets_ : assets_ * totalSupply / total;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return totalSupply == 0 ? shares : shares * totalAssets() / totalSupply;
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        uint256 owned = convertToAssets(balanceOf[owner]);
        uint256 liquid = liquidAssets();
        return owned < liquid ? owned : liquid;
    }

    function previewWithdraw(uint256 assets_) external view returns (uint256) {
        return convertToShares(assets_);
    }

    function venues() external view returns (address[] memory) {
        return _venues;
    }

    // ── Treasury interface (ERC-4626) ──

    /// @notice Treasury deposits idle reserves. The cap on how much may come
    ///         here is enforced on the Treasury side.
    function deposit(uint256 assets_, address receiver) external returns (uint256 shares) {
        _checkWired();
        if (msg.sender != treasury) revert NotTreasury();
        if (assets_ == 0) revert ZeroAmount();
        shares = convertToShares(assets_);
        if (!asset.transferFrom(msg.sender, address(this), assets_)) revert TransferFailed();
        totalSupply += shares;
        balanceOf[receiver] += shares;
        emit Deposited(assets_, shares);
        emit Transfer(address(0), receiver, shares);
    }

    /// @notice Return reserves to the treasury.
    /// @dev Only fulfilled from liquid GME. If the manager has the sleeve
    ///      committed to a position, this reverts and the position must be
    ///      settled first — the desk cannot unwind a leveraged venue position
    ///      synchronously and will not pretend otherwise. The Treasury's
    ///      auto-unwind path is a safety net that should rarely fire, because
    ///      the buyback's capacity is keyed to liquid reserves, which exclude
    ///      everything held here.
    function withdraw(uint256 assets_, address receiver, address owner)
        external
        returns (uint256 shares)
    {
        _checkWired();
        if (msg.sender != treasury) revert NotTreasury();
        if (receiver != treasury) revert OnlyTreasuryMayReceive();
        if (assets_ == 0) revert ZeroAmount();
        if (assets_ > liquidAssets()) revert InsufficientLiquid();

        shares = convertToShares(assets_);
        if (balanceOf[owner] < shares) revert InsufficientLiquid();
        balanceOf[owner] -= shares;
        totalSupply -= shares;
        if (!asset.transfer(receiver, assets_)) revert TransferFailed();
        emit Withdrawn(assets_, shares);
        emit Transfer(owner, address(0), shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets_) {
        _checkWired();
        if (msg.sender != treasury) revert NotTreasury();
        if (receiver != treasury) revert OnlyTreasuryMayReceive();
        assets_ = convertToAssets(shares);
        if (assets_ > liquidAssets()) revert InsufficientLiquid();
        balanceOf[owner] -= shares;
        totalSupply -= shares;
        if (!asset.transfer(receiver, assets_)) revert TransferFailed();
        emit Withdrawn(assets_, shares);
        emit Transfer(owner, address(0), shares);
    }

    // ── Position management (manager only) ──

    /// @notice Commits collateral to a leveraged position and records its
    ///         terms, so the front end can show entry, size and leverage
    ///         without trusting an off-chain feed for the facts.
    /// @param venue Where the position lives. Must be one of the immutable set.
    /// @param collateral GME to commit, sent to the venue.
    /// @param sizeUnits GME-equivalent exposure the position carries.
    /// @param entryPriceWad Entry price of GME in the quote asset, WAD.
    /// @param debtQuoteWad Quote-denominated borrowings, WAD.
    function openPosition(
        address venue,
        uint256 collateral,
        uint256 sizeUnits,
        uint256 entryPriceWad,
        uint256 debtQuoteWad
    ) external onlyManager {
        if (position.collateral != 0) revert PositionOpen();
        if (!isVenue[venue]) revert UnknownVenue();
        if (collateral == 0) revert ZeroAmount();
        if (collateral > liquidAssets()) revert InsufficientLiquid();

        position = Position({
            venue: venue,
            collateral: collateral,
            sizeUnits: sizeUnits,
            entryPriceWad: entryPriceWad,
            debtQuoteWad: debtQuoteWad,
            liquidAtOpen: 0,
            openedAt: uint64(block.timestamp)
        });

        if (!asset.transfer(venue, collateral)) revert TransferFailed();
        position.liquidAtOpen = liquidAssets();
        emit PositionOpened(venue, collateral, sizeUnits, entryPriceWad, debtQuoteWad);
        emit SentToVenue(venue, collateral);
    }

    /// @notice Closes the position by returning GME from the venue. Profit or
    ///         loss is realised here and shows up in backing immediately.
    /// @dev The manager must have sent the proceeds to this contract first; the
    ///      difference against the recorded collateral is the realised result.
    function settlePosition() external onlyManager returns (int256 pnl) {
        uint256 collateral = position.collateral;
        if (collateral == 0) revert NoPosition();

        // Only GME that arrived since the position was funded counts as
        // proceeds. A donation to this contract while a position is open would
        // read as profit, which is harmless: it genuinely did raise backing.
        uint256 liquid = liquidAssets();
        uint256 atOpen = position.liquidAtOpen;
        uint256 returned = liquid > atOpen ? liquid - atOpen : 0;
        pnl = int256(returned) - int256(collateral);
        realisedPnl += pnl;

        address venue = position.venue;
        delete position;
        emit PositionSettled(venue, collateral, returned, pnl);
    }

    /// @notice Tops an open position up, for example to defend it against
    ///         liquidation. Increases committed collateral, so backing is
    ///         unchanged — the GME simply moves from liquid to deployed.
    function addCollateral(uint256 amount) external onlyManager {
        if (position.collateral == 0) revert NoPosition();
        if (amount == 0) revert ZeroAmount();
        if (amount > liquidAssets()) revert InsufficientLiquid();

        position.collateral += amount;
        if (!asset.transfer(position.venue, amount)) revert TransferFailed();
        // Re-baseline, so the top-up is not later counted as proceeds.
        position.liquidAtOpen = liquidAssets();
        emit SentToVenue(position.venue, amount);
    }

    /// @notice Updates the recorded terms of a live position after the manager
    ///         has adjusted it at the venue. Cannot move any GME.
    function updateTerms(uint256 sizeUnits, uint256 entryPriceWad, uint256 debtQuoteWad)
        external
        onlyManager
    {
        if (position.collateral == 0) revert NoPosition();
        position.sizeUnits = sizeUnits;
        position.entryPriceWad = entryPriceWad;
        position.debtQuoteWad = debtQuoteWad;
    }

    /// @notice Leverage of the open position, WAD. Zero when flat.
    function leverageWad() external view returns (uint256) {
        if (position.collateral == 0) return 0;
        return position.sizeUnits * Constants.WAD / position.collateral;
    }

    // ── Minimal ERC-20 on the shares ──
    //
    // Only the treasury ever holds these, but ERC-4626 implies ERC-20 and the
    // Treasury reads `balanceOf`.

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
            if (allowed < value) revert TransferFailed();
            allowance[from][msg.sender] = allowed - value;
        }
        return _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < value) revert TransferFailed();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
