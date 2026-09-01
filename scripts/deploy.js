require('dotenv').config();
const hre = require('hardhat');

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const FlashArb = await hre.ethers.getContractFactory('FlashArbitrageBot');
  const flash = await FlashArb.deploy(
    process.env.AAVE_PROVIDER,
    process.env.UNISWAP_ROUTER,
    process.env.SUSHISWAP_ROUTER,
    signer.address
  );
  await flash.deployed();
  console.log('FlashArbitrageBot deployed to:', flash.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
