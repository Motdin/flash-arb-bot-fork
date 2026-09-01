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

async function checkArbitrage() {
  try {
    // Provider & signer (wallet)
    const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const flash = new ethers.Contract(process.env.FLASH_CONTRACT_ADDRESS, flashAbi, signer);
    const tokenIn = process.env.DAI_TOKEN; // token to borrow
    const tokenOut = process.env.WETH_TOKEN; // token to receive
    const amountIn = ethers.utils.parseUnits('100', 18); // 100 DAI
    const minOut = ethers.utils.parseUnits('0.05', 18); // minimal output

    // Get price from two DEXes
    const routerIn = process.env.UNISWAP_ROUTER;
    const routerOut = process.env.SUSHISWAP_ROUTER;
    const pathTokens = [tokenIn, tokenOut];
    const uni = new ethers.Contract(routerIn, ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'], provider);
    const sushi = new ethers.Contract(routerOut, ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'], provider);
    const [outUni] = await uni.getAmountsOut(amountIn, pathTokens);
    const [outSushi] = await sushi.getAmountsOut(amountIn, pathTokens);
    console.log('🔎 outUni (Uniswap)  =', ethers.utils.formatUnits(outUni, 18));
    console.log('🔎 outSushi (Sushiswap) =', ethers.utils.formatUnits(outSushi, 18));

    let routerBuy, routerSell, profitCandidate;
    if (outUni > outSushi) {
      // buy on Sushi (cheaper), sell on Uni
      routerBuy = routerOut;
      routerSell = routerIn;
      profitCandidate = outUni - outSushi;
    } else if (outSushi > outUni) {
      routerBuy = routerIn;
      routerSell = routerOut;
      profitCandidate = outSushi - outUni;
    } else {
      // no price difference
      sendTelegramMessage('🔎 No arbitrage opportunity detected at this block.');
      return;
    }

    // Minimum profit threshold (0.1% of amountIn)
    const minProfit = amountIn * 10n / 10000n; // 0.1%
    if (profitCandidate < minProfit) {
      sendTelegramMessage(`📉 Detected price gap but profit (${ethers.utils.formatUnits(profitCandidate, 18)} token) < threshold (${ethers.utils.formatUnits(minProfit, 18)}).`);
      return;
    }

    // Execute flashloan arbitrage
    const tx = await flash.flashloanArb(tokenIn, tokenOut, amountIn, minOut, routerBuy, routerSell);
    const receipt = await tx.wait();
    const msg = `✅ Arbitrage executed! Tx: ${receipt.transactionHash}\nProfit: ${ethers.utils.formatUnits(profitCandidate, 18)} ${tokenIn}\nRouted via buy ${routerBuy} → sell ${routerSell}`;
    sendTelegramMessage(msg);
  } catch (err) {
    console.error('⚠️ Error in monitor (caught):', err.stack);
    sendTelegramMessage(`⚠️ Error in monitor: ${err.message}`);
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
