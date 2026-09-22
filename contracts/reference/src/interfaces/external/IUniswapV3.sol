// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap v3 factory surface used for the pair-mapping
///         setter's on-chain pool validation (specs/tax.md §1).
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee)
        external
        view
        returns (address pool);
}
