const path = require('path');
const json = require(path.join(__dirname,'artifacts','contracts','FlashArbitrageBot.sol','FlashArbitrageBot.json'));
console.log('loaded', Object.keys(json).length);
