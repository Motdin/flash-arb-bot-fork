require('dotenv').config();
const { ethers } = require('hardhat');

async function main() {
  const flashAddress = process.env.FLASH_CONTRACT_ADDRESS;
  if (!flashAddress) {
    console.error('Set FLASH_CONTRACT_ADDRESS in .env');
    process.exit(1);
  }
  const FlashArb = await ethers.getContractFactory('FlashArbitrageBot');
  const flash = FlashArb.attach(flashAddress);

  // Example: borrow 1000 DAI (18 decimals) and arbitrage DAI ↔ ETH
  const flashAsset = process.env.DAI_TOKEN; // token to borrow
  const amount = ethers.parseUnits('1000', 18);
  const daiToken = process.env.DAI_TOKEN;
  const amountToTrade = ethers.parseEther('0.5'); // 0.5 ETH worth of DAI to trade
  const tokensOut = ethers.parseUnits('1000', 18); // dummy placeholder

  console.log('Executing flashloan...');
  const tx = await flash.flashloan(flashAsset, amount, daiToken, amountToTrade, tokensOut);
  const receipt = await tx.wait();
  console.log('Flashloan tx hash:', receipt.transactionHash);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
