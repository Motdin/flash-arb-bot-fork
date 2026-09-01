require('dotenv').config();
const INTERVAL_MS = 300000;
console.log('🔧 .env loaded – config:', {
  RPC_URL: process.env.RPC_URL ? '[set]' : '[missing]',
  FLASH_CONTRACT_ADDRESS: process.env.FLASH_CONTRACT_ADDRESS ? '[set]' : '[missing]',
  DAI_TOKEN: process.env.DAI_TOKEN ? '[set]' : '[missing]',
  WETH_TOKEN: process.env.WETH_TOKEN ? '[set]' : '[missing]',
  UNISWAP_ROUTER: process.env.UNISWAP_ROUTER ? '[set]' : '[missing]',
  SUSHISWAP_ROUTER: process.env.SUSHISWAP_ROUTER ? '[set]' : '[missing]',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ? '[set]' : '[missing]',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ? '[set]' : '[missing]'
});
const ethers = require('ethers');
// load Telegram helper
const { sendTelegramMessage } = require('./telegram');
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  console.error('❌ Telegram credentials missing – bot will not send messages.');
  // continue without sending; functions will silently return.
}

const path = require('path');
const flashAbi = require(path.join(__dirname, 'artifacts', 'contracts', 'FlashArbitrageBot.sol', 'FlashArbitrageBot.json')).abi;

// interval in milliseconds (default 30 seconds)
// ------------------ Private‑key validation ------------------
if (!process.env.PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY missing in .env – aborting monitor.');
  process.exit(1);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.PRIVATE_KEY)) {
  console.error('❌ PRIVATE_KEY malformed – must be 0x + 64 hex chars.');
  process.exit(1);
}
// -----------------------------------------------------------

// Provider & signer (wallet) – created once to avoid resource leak
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const flash = new ethers.Contract(process.env.FLASH_CONTRACT_ADDRESS, flashAbi, signer);

async function checkArbitrage() {
  if (global.isRunning) return; // prevent overlap
  global.isRunning = true;
  try {
    // Load parameters
    const tokenIn = process.env.DAI_TOKEN; // token to borrow
    const tokenOut = process.env.WETH_TOKEN; // token to receive
    const amountIn = ethers.utils.parseUnits('100', 18); // 100 DAI
    const minOut = ethers.utils.parseUnits('0.05', 18);

    // Query price from Uniswap V2 and Sushiswap V2
    const routerIn = process.env.UNISWAP_ROUTER;
    const routerOut = process.env.SUSHISWAP_ROUTER;
    const pathTokens = [tokenIn, tokenOut];
    const uni = new ethers.Contract(routerIn, ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'], provider);
    const sushi = new ethers.Contract(routerOut, ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'], provider);
    const [, outUni] = await uni.getAmountsOut(amountIn, pathTokens);
    const [, outSushi] = await sushi.getAmountsOut(amountIn, pathTokens);
    console.log('🔎 outUni (Uniswap)  =', ethers.utils.formatUnits(outUni, 18));
    console.log('🔎 outSushi (Sushiswap) =', ethers.utils.formatUnits(outSushi, 18));

    // Determine arbitrage direction
    let routerBuy, routerSell, profitCandidate;
    if (outUni.gt(outSushi)) {
      routerBuy = routerOut; // cheaper on Sushi
      routerSell = routerIn;
      profitCandidate = outUni.sub(outSushi);
    } else if (outSushi.gt(outUni)) {
      routerBuy = routerIn;
      routerSell = routerOut;
      profitCandidate = outSushi.sub(outUni);
    } else {
      sendTelegramMessage('🔎 No arbitrage opportunity detected at this block.');
      return;
    }

    // ---------- Cost calculations ----------
    const FLASH_FEE_BPS = 9; // 0.09% Aave flash‑loan fee
    const SLIPPAGE_BPS = 50; // 0.5% slippage tolerance
    const flashFee = amountIn.mul(FLASH_FEE_BPS).div(10000);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.utils.parseUnits('1', 'gwei');
    const estGas = await flash.estimateGas.flashloanArb(tokenIn, tokenOut, amountIn, minOut, routerBuy, routerSell);
    const gasCostWei = gasPrice.mul(estGas); // gas cost in wei (ETH)
    // Get ETH price in DAI (1 ETH -> DAI) via Uniswap
    const ethAmount = ethers.utils.parseUnits('1', 18);
    const [, ethPriceInDai] = await uni.getAmountsOut(ethAmount, [process.env.WETH_TOKEN, process.env.DAI_TOKEN]);
    const gasCost = gasCostWei.mul(ethPriceInDai).div(ethers.utils.parseUnits('1', 18)); // convert to DAI
    const slippageCost = profitCandidate.mul(SLIPPAGE_BPS).div(10000);
    const totalCost = flashFee.add(gasCost).add(slippageCost);

    console.log('💰 profitCandidate =', ethers.utils.formatUnits(profitCandidate, 18));
    console.log('💸 flashFee       =', ethers.utils.formatUnits(flashFee, 18));
    console.log('⛽ estimatedGas   =', estGas.toString(), 'gas @', ethers.utils.formatUnits(gasPrice, 'gwei'), 'gwei');
    console.log('🧾 gasCostWei    =', ethers.utils.formatUnits(gasCostWei, 18), 'ETH');
    console.log('💱 gasCost (DAI)  =', ethers.utils.formatUnits(gasCost, 18));
    console.log('↔️ slippageCost   =', ethers.utils.formatUnits(slippageCost, 18));
    console.log('🧮 totalCost      =', ethers.utils.formatUnits(totalCost, 18));

    // Ensure profit exceeds all costs
    if (profitCandidate.lte(totalCost)) {
      sendTelegramMessage(`📉 Detected price gap but net profit (${ethers.utils.formatUnits(profitCandidate.sub(totalCost), 18)} ${tokenIn}) ≤ total cost (${ethers.utils.formatUnits(totalCost, 18)}).`);
      return;
    }

    // ---------- Static simulation ----------
    try {
      await flash.callStatic.flashloanArb(tokenIn, tokenOut, amountIn, minOut, routerBuy, routerSell);
    } catch (simErr) {
      console.error('⚠️ Simulation failed:', simErr);
      sendTelegramMessage(`⚠️ Simulation of flashloan failed: ${simErr.message}`);
      return;
    }

    // ---------- Execute arbitrage ----------
    const tx = await flash.flashloanArb(tokenIn, tokenOut, amountIn, minOut, routerBuy, routerSell);
    const receipt = await tx.wait();
    const netProfit = profitCandidate.sub(totalCost);
    const msg = `✅ Arbitrage executed! Tx: ${receipt.transactionHash}\nGross profit: ${ethers.utils.formatUnits(profitCandidate, 18)} ${tokenIn}\nNet profit after fees & gas: ${ethers.utils.formatUnits(netProfit, 18)} ${tokenIn}\nRouted via buy ${routerBuy} → sell ${routerSell}`;
    sendTelegramMessage(msg);  } catch (err) {
    console.error('⚠️ Error in monitor (caught):', err.stack);
    sendTelegramMessage(`⚠️ Error in monitor: ${err.message}`);
  } finally {
    global.isRunning = false;
  }
}

console.log(`🚀 Starting monitor, interval ${INTERVAL_MS / 1000}s`);
if (process.argv.includes('--once')) {
  // Run once and exit
  checkArbitrage().then(() => process.exit(0)).catch(() => process.exit(1));
} else {
  setInterval(checkArbitrage, INTERVAL_MS);
  // Run immediately once on start
  checkArbitrage();
}
