require('dotenv').config();
const { ethers } = require('hardhat');
const { sendTelegramMessage } = require('./telegram');

// interval in milliseconds (default 30 seconds)
const INTERVAL_MS = process.env.MONITOR_INTERVAL_MS ? parseInt(process.env.MONITOR_INTERVAL_MS) : 30000;

async function checkArbitrage() {
  try {
    const flash = await ethers.getContractAt('FlashArbitrageBot', process.env.FLASH_CONTRACT_ADDRESS);
    const tokenIn = process.env.DAI_TOKEN; // contoh token yang dipinjam
    const tokenOut = process.env.WETH_TOKEN; // pastikan WETH_TOKEN ada di .env
    const amountIn = ethers.utils.parseUnits('100', 18); // 100 DAI
    const minOut = ethers.utils.parseUnits('0.05', 18); // contoh minimal output

    // Dapatkan harga di dua DEX
    const routerIn = process.env.UNISWAP_ROUTER;
    const routerOut = process.env.SUSHISWAP_ROUTER;
    const path = [tokenIn, tokenOut];
    const uni = new ethers.Contract(routerIn, ['function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'], ethers.provider);
    const sushi = new ethers.Contract(routerOut, ['function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'], ethers.provider);
    const [outUni] = await uni.getAmountsOut(amountIn, path);
    const [outSushi] = await sushi.getAmountsOut(amountIn, path);

    let routerBuy, routerSell, profitCandidate;
    if (outUni.gt(outSushi)) {
      // beli di Sushi (lebih murah), jual di Uni
      routerBuy = routerOut;
      routerSell = routerIn;
      profitCandidate = outUni.sub(outSushi);
    } else if (outSushi.gt(outUni)) {
      routerBuy = routerIn;
      routerSell = routerOut;
      profitCandidate = outSushi.sub(outUni);
    } else {
      // tidak ada selisih
      sendTelegramMessage('🔎 No arbitrage opportunity detected at this block.');
      return;
    }

    // skalakan profit minimal (misal 0.1% dari amountIn)
    const minProfit = amountIn.mul(10).div(10000); // 0.1%
    if (profitCandidate.lt(minProfit)) {
      sendTelegramMessage(`📉 Detected price gap but profit (${ethers.utils.formatUnits(profitCandidate, 18)} token) < threshold (${ethers.utils.formatUnits(minProfit, 18)}).`);
      return;
    }

    // panggil flashloanArb dengan parameter yang sudah disiapkan
    const tx = await flash.flashloanArb(tokenIn, tokenOut, amountIn, minOut, routerBuy, routerSell);
    const receipt = await tx.wait();
    const msg = `✅ Arbitrage executed! Tx: ${receipt.transactionHash}\nProfit: ${ethers.utils.formatUnits(profitCandidate, 18)} ${tokenIn}\nRouted via buy ${routerBuy} → sell ${routerSell}`;
    sendTelegramMessage(msg);
  } catch (err) {
    sendTelegramMessage(`⚠️ Error in monitor: ${err.message}`);
  }
}

console.log(`🚀 Starting monitor, interval ${INTERVAL_MS / 1000}s`);
setInterval(checkArbitrage, INTERVAL_MS);
// Run immediately once on start
checkArbitrage();
