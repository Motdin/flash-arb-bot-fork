// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26; // updated

import "./AaveMock.sol";
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

contract FlashArbitrageBot is FlashLoanReceiverBase, Ownable {
    // Cold wallet to receive profits; gasReserve keeps enough ETH for future tx fees
    address public coldWallet;
    uint256 public gasReserve;

    /**
        Set the cold wallet address and the minimum ETH to keep for gas.
        Only the owner can call.
    */
    function setColdWallet(address _coldWallet, uint256 _gasReserve) external onlyOwner {
        coldWallet = _coldWallet;
        gasReserve = _gasReserve;
    }

    using SafeMath for uint256;
    IUniswapV2Router02 public uniswapV2Router;
    IUniswapV2Router02 public sushiswapV1Router;
    uint public deadline;
    IERC20 public dai;
    address public daiTokenAddress;
    uint256 public amountToTrade;
    uint256 public tokensOut;
    ILendingPoolAddressesProvider public aaveProvider;


    /**
        Initialize deployment parameters
    */
    constructor(
        address _aaveAddressesProvider,
        IUniswapV2Router02 _uniswapV2Router,
        IUniswapV2Router02 _sushiswapV1Router,
        address _owner
    ) FlashLoanReceiverBase(_aaveAddressesProvider) Ownable(_owner) {
        sushiswapV1Router = _sushiswapV1Router;
        uniswapV2Router = _uniswapV2Router;
        deadline = block.timestamp + 300; // 5 minutes
    }

    /**
        Mid-flashloan logic i.e. what you do with the temporarily acquired flash liquidity
    */
    // First executeOperation removed – later version (lines 212‑233) handles custom params

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
    /**
    * Withdraw all balances.
    * Sends ETH balance minus `gasReserve` to `coldWallet` (if set), otherwise to owner.
    * Sends all ERC20 tokens to `coldWallet` (or owner) as well.
    */
    function withdrawBalance() external onlyOwner {
        uint256 ethBalance = address(this).balance;
        uint256 toSend = 0;
        if (coldWallet != address(0) && ethBalance > gasReserve) {
            toSend = ethBalance - gasReserve;
            (bool sent, ) = coldWallet.call{value: toSend}('');
            require(sent, 'ETH transfer to cold wallet failed');
        } else {
            // fallback to owner if cold wallet not set or not enough ETH
            (bool sent, ) = msg.sender.call{value: ethBalance}('');
            require(sent, 'ETH transfer to owner failed');
        }
        // transfer all ERC20 tokens (DAI) to cold wallet if set, else owner
        address tokenRecipient = coldWallet != address(0) ? coldWallet : msg.sender;
        uint256 tokenBal = dai.balanceOf(address(this));
        if (tokenBal > 0) {
            dai.transfer(tokenRecipient, tokenBal);
        }
    }

    /**
        Initiate flash loan
    */
    struct ArbParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        address routerIn;
        address routerOut;
    }

    /**
        Initiate flash loan with custom arbitrage parameters
    */
    function flashloanArb(
        address _flashAsset,
        uint256 _flashAmount,
        ArbParams calldata params
    ) external onlyOwner {
        // Encode parameters to pass to executeOperation
        bytes memory data = abi.encode(params);
        // ILendingPool lendingPool = ILendingPool(addressesProvider.getLendingPool());
        ILendingPool lendingPool = ILendingPool(aaveProvider.getLendingPool());
        lendingPool.flashLoan(address(this), _flashAsset, _flashAmount, data);
    }

    /**
        Custom arbitrage executed during flash loan
    */
    function executeCustomArbitrage(ArbParams memory params) internal {
        // Approve routerIn to spend tokenIn
        IERC20(params.tokenIn).approve(params.routerIn, params.amountIn);
        // Swap tokenIn -> tokenOut on routerIn
        IUniswapV2Router02 routerIn = IUniswapV2Router02(params.routerIn);
        address[] memory path1 = new address[](2);
        path1[0] = params.tokenIn;
        path1[1] = params.tokenOut;
        uint256 outAmount = routerIn.swapExactTokensForTokens(
            params.amountIn,
            params.minOut,
            path1,
            address(this),
            deadline
        )[1];
        // Approve routerOut to spend tokenOut
        IERC20(params.tokenOut).approve(params.routerOut, outAmount);
        // Swap back tokenOut -> tokenIn on routerOut (simple reverse swap)
        IUniswapV2Router02 routerOut = IUniswapV2Router02(params.routerOut);
        address[] memory path2 = new address[](2);
        path2[0] = params.tokenOut;
        path2[1] = params.tokenIn;
        uint256 finalAmount = routerOut.swapExactTokensForTokens(
            outAmount,
            0,
            path2,
            address(this),
            deadline
        )[1];
        // Profit is finalAmount - params.amountIn
        uint256 profit = 0;
        if (finalAmount > params.amountIn) {
            profit = finalAmount - params.amountIn;
            emit ArbExecuted(msg.sender, params.tokenIn, params.tokenOut, profit);
            // auto‑transfer profit to cold wallet if set
            if (coldWallet != address(0) && profit > 0) {
                IERC20(params.tokenIn).transfer(coldWallet, profit);
            }
        }

    }

    // Event for profit monitoring
    event ArbExecuted(address indexed initiator, address tokenIn, address tokenOut, uint256 profit);

    // Modified executeOperation to handle optional params
    function executeOperation(
        address _reserve,
        uint256 _amount,
        uint256 _fee,
        bytes calldata _params
    ) external override {
        require(_amount <= getBalanceInternal(address(this), _reserve), "Invalid balance");
        if (_params.length > 0) {
            // Custom arbitrage path
            ArbParams memory custom = abi.decode(_params, (ArbParams));
            executeCustomArbitrage(custom);
        } else {
            // default arbitrage
            try this.executeArbitrage() {
            } catch Error(string memory) {
            } catch (bytes memory) {
            }
        }
        uint256 totalDebt = _amount.add(_fee);
        transferFundsBackToPoolInternal(_reserve, totalDebt);
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
