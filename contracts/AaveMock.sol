// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Minimal mock definitions for Aave v3 contracts used in FlashArbitrageBot.sol

abstract contract FlashLoanReceiverBase {
    address public immutable addressesProvider;
    constructor(address _provider) { addressesProvider = _provider; }
    function executeOperation(address _reserve, uint256 _amount, uint256 _fee, bytes calldata _params) external virtual;
    // Helper stubs
    function getBalanceInternal(address account, address token) internal view returns (uint256) { return 0; }
    function transferFundsBackToPoolInternal(address token, uint256 amount) internal {}
}

interface ILendingPoolAddressesProvider {
    function getLendingPool() external view returns (address);
}

interface ILendingPool {
    function flashLoan(address receiverAddress, address asset, uint256 amount, bytes calldata params) external;
}
