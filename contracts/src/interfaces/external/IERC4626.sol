// SPDX-License-Identifier: AGPL-3.0-only
// Forked from NetNet Capital (AGPL-3.0-only). Renamed NET -> MOASS and modified for
// Moass Fund; see ../SOURCE.md for provenance and reference/ for the unmodified original.
pragma solidity ^0.8.24;

import {IERC20Metadata} from "./IERC20.sol";

/// @notice Minimal ERC-4626 tokenized-vault surface used for the Morpho USDG
///         vault (specs/treasury.md §2). The vault address itself comes only
///         from packages/sdk addresses (OPEN_QUESTIONS Q9).
interface IERC4626 is IERC20Metadata {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner)
        external
        returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
    function maxWithdraw(address owner) external view returns (uint256 assets);
    function previewWithdraw(uint256 assets) external view returns (uint256 shares);
}
