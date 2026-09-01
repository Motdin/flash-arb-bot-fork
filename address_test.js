require('dotenv').config();
const { ethers } = require('ethers');
const pk = process.env.PRIVATE_KEY;
if (!pk) { console.error('PRIVATE_KEY missing'); process.exit(1); }
const wallet = new ethers.Wallet(pk);
console.log('address', wallet.address);
