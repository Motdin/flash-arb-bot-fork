require('dotenv').config();
const hre = require('hardhat');

async function main() {
  const FlashArb = await hre.ethers.getContractFactory('FlashArbitrageBot');
  const flash = await FlashArb.deploy(
    process.env.AAVE_PROVIDER,
    process.env.UNISWAP_ROUTER,
    process.env.SUSHISWAP_ROUTER
  );
  await flash.deployed();
  console.log('FlashArbitrageBot deployed to:', flash.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
