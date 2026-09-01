require('dotenv').config();
const INTERVAL_MS = 30000; // 30 detik (scan lebih sering)
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
    // Daftar pasangan yang akan dipindai (DAI↔WETH and USDC↔WETH)
    const PAIRS = [
      [process.env.DAI_TOKEN,  process.env.WETH_TOKEN],
      [process.env.USDC_TOKEN, process.env.WETH_TOKEN]
    ];
    const amountIn = ethers.utils.parseUnits('100', 18); // 100 unit per token
    const SLIPPAGE_BPS = 50; // 0.5% slippage tolerance

    // Helper untuk memindai satu pasangan
    async function scanPair(tokenIn, tokenOut) {
      // Query price from Uniswap V2 and Sushiswap V2 (fallback to V3 if you later add logic)
      const routerIn = process.env.UNISWAP_ROUTER;
      const routerOut = process.env.SUSHISWAP_ROUTER;
      const pathTokens = [tokenIn, tokenOut];
      const uni = new ethers.Contract(routerIn, ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'], provider);
      const sushi = new ethers.Contract(routerOut, ['function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'], provider);
      const [, outUni] = await uni.getAmountsOut(amountIn, pathTokens);
      const [, outSushi] = await sushi.getAmountsOut(amountIn, pathTokens);
      console.log(`🔎 Pair ${tokenIn.slice(0,6)}→${tokenOut.slice(0,6)} – outUni =`, ethers.utils.formatUnits(outUni, 18));
      console.log(`🔎 Pair ${tokenIn.slice(0,6)}→${tokenOut.slice(0,6)} – outSushi =`, ethers.utils.formatUnits(outSushi, 18));

      // Tentukan arah arbitrase
      let routerBuy, routerSell;
      if (outUni.gt(outSushi)) {
        routerBuy = routerIn;
        routerSell = routerOut;
      } else {
        routerBuy = routerOut;
        routerSell = routerIn;
      }

      // 1️⃣ tokenIn → tokenOut pada routerBuy
      const [, amountOut] = await (routerBuy === routerIn ? uni : sushi).getAmountsOut(amountIn, [tokenIn, tokenOut]);

      // Slippage tolerance
      const slippageAllowance = amountOut.mul(SLIPPAGE_BPS).div(10000);
      const minOut = amountOut.sub(slippageAllowance);

      // tokenOut → tokenIn pada routerSell (return leg)
      const [, amountBack] = await (routerSell === routerIn ? uni : sushi).getAmountsOut(amountOut, [tokenOut, tokenIn]);

      // Tidak ada peluang arbitrase
      if (amountBack.lte(amountIn)) {
        sendTelegramMessage('🔎 No arbitrage opportunity detected for this pair.');
        return; // skip to next pair
      }

      const profitCandidate = amountBack.sub(amountIn);

      // ---------- Cost calculations ----------
      const FLASH_FEE_BPS = 9; // 0.09% Aave flash‑loan fee
      const flashFee = amountIn.mul(FLASH_FEE_BPS).div(10000);
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || ethers.utils.parseUnits('1', 'gwei');
      const estGas = await flash.estimateGas.flashloanArb(tokenIn, tokenOut, amountIn, minOut, routerBuy, routerSell);
      const gasCostWei = gasPrice.mul(estGas);
      // Get ETH price in DAI via Uniswap (used as price reference for gas conversion)
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

      // Pastikan profit lebih besar dari total biaya
      if (profitCandidate.lte(totalCost)) {
        const netLoss = totalCost.sub(profitCandidate);
        sendTelegramMessage(`📉 Net profit negative – loss ${ethers.utils.formatUnits(netLoss, 18)} ${tokenIn} (cost ${ethers.utils.formatUnits(totalCost, 18)}).`);
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
      const msg = `✅ Arbitrage executed! Tx: ${receipt.transactionHash}\nPair: ${tokenIn.slice(0,6)}→${tokenOut.slice(0,6)}\nGross: ${ethers.utils.formatUnits(profitCandidate, 18)} ${tokenIn}\nNet: ${ethers.utils.formatUnits(netProfit, 18)} ${tokenIn}\nBuy ${routerBuy} → Sell ${routerSell}`;
      sendTelegramMessage(msg);
    }

    // Scan semua pasangan yang ada
    for (const [tkIn, tkOut] of PAIRS) {
      await scanPair(tkIn, tkOut);
    }
  } catch (err) {
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
