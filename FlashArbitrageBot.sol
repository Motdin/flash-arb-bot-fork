// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26; // updated

import "@aave/protocol-v3/contracts/flashloan/base/FlashLoanReceiverBase.sol";
import "@aave/protocol-v3/contracts/interfaces/ILendingPoolAddressesProvider.sol";
import "@aave/protocol-v3/contracts/interfaces/ILendingPool.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";

/**
    Ropsten instances:
    - Uniswap V2 Router:                    0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D
    - Sushiswap V1 Router:                  No official sushi routers on testnet
    - DAI:                                  0xf80A32A835F79D7787E8a8ee5721D0fEaFd78108
    - ETH:                                  0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
    - Aave LendingPoolAddressesProvider:    0x1c8756FD2B28e9426CDBDcC7E3c4d64fa9A54728
    
    Mainnet instances:
    - Uniswap V2 Router:                    0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D
    - Sushiswap V1 Router:                  0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F
    - DAI:                                  0x6B175474E89094C44Da98b954EedeAC495271d0F
    - ETH:                                  0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
    - Aave LendingPoolAddressesProvider:    0x24a42fD28C976A61Df5D00D0599C34c4f90748c8
*/

contract FlashArbBot is FlashLoanReceiverBase, Ownable {
    using SafeMath for uint256;
    IUniswapV2Router02 public uniswapV2Router;
    IUniswapV2Router02 public sushiswapV1Router;
    uint public deadline;
    IERC20 public dai;
    address public daiTokenAddress;
    uint256 public amountToTrade;
    uint256 public tokensOut;
    ILendingPoolAddressesProvider public addressesProvider;

    /**
        Initialize deployment parameters
    */
    constructor(
        address _aaveAddressesProvider,
        IUniswapV2Router02 _uniswapV2Router,
        IUniswapV2Router02 _sushiswapV1Router
    ) FlashLoanReceiverBase(_aaveAddressesProvider) {
        addressesProvider = ILendingPoolAddressesProvider(_aaveAddressesProvider);
        sushiswapV1Router = _sushiswapV1Router;
        uniswapV2Router = _uniswapV2Router;
        deadline = block.timestamp + 300; // 5 minutes
    }

    /**
        Mid-flashloan logic i.e. what you do with the temporarily acquired flash liquidity
    */
    function executeOperation(
        address _reserve,
        uint256 _amount,
        uint256 _fee,
        bytes calldata _params
    ) external override {
        require(_amount <= getBalanceInternal(address(this), _reserve), "Invalid balance");
        // execute arbitrage strategy – keep‑try/catch for safety
        try this.executeArbitrage() {
        } catch Error(string memory) {
        } catch (bytes memory) {
        }
        // repay loan + fee
        uint256 totalDebt = _amount.add(_fee);
        transferFundsBackToPoolInternal(_reserve, totalDebt);
    }

    /**
        Simple arbitrage: UniswapV2 -> SushiswapV1
    */
    function executeArbitrage() public {
        // 1) swap ETH -> DAI on UniswapV2
        try uniswapV2Router.swapETHForExactTokens{ value: amountToTrade }(
            amountToTrade,
            getPathForETHToToken(daiTokenAddress),
            address(this),
            deadline
        ) {} catch {}
        // 2) approve DAI for the routers
        uint256 tokenAmountInWEI = tokensOut.mul(1e18);
        uint256 estimatedETH = getEstimatedETHForToken(tokensOut, daiTokenAddress)[0];
        dai.approve(address(uniswapV2Router), tokenAmountInWEI);
        dai.approve(address(sushiswapV1Router), tokenAmountInWEI);
        // 3) swap DAI -> ETH on Sushiswap
        try sushiswapV1Router.swapExactTokensForETH(
            tokenAmountInWEI,
            estimatedETH,
            getPathForTokenToETH(daiTokenAddress),
            address(this),
            deadline
        ) {} catch {}
    }

    /**
        Withdraw all balances to owner
    */
    function withdrawBalance() external onlyOwner {
        // ETH
        (bool sent, ) = msg.sender.call{value: address(this).balance}('');
        require(sent, 'ETH transfer failed');
        // DAI
        dai.transfer(msg.sender, dai.balanceOf(address(this)));
    }

    /**
        Initiate flash loan
    */
    function flashloan(
        address _flashAsset,
        uint256 _flashAmount,
        address _daiTokenAddress,
        uint256 _amountToTrade,
        uint256 _tokensOut
    ) external onlyOwner {
        bytes memory data = "";
        daiTokenAddress = _daiTokenAddress;
        dai = IERC20(daiTokenAddress);
        amountToTrade = _amountToTrade;
        tokensOut = _tokensOut;
        ILendingPool lendingPool = ILendingPool(addressesProvider.getLendingPool());
        lendingPool.flashLoan(address(this), _flashAsset, _flashAmount, data);
    }

    function getPathForETHToToken(address token) private view returns (address[] memory) {
        address[] memory path = new address[](2);
        path[0] = uniswapV2Router.WETH();
        path[1] = token;
        return path;
    }

    function getPathForTokenToETH(address token) private view returns (address[] memory) {
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = sushiswapV1Router.WETH();
        return path;
    }

    function getEstimatedETHForToken(uint256 tokenAmount, address token) public view returns (uint256[] memory) {
        return uniswapV2Router.getAmountsOut(tokenAmount, getPathForTokenToETH(token));
    }

    receive() external payable {}
}
