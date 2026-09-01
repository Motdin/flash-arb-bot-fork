require('dotenv').config();
const vars = ['AAVE_PROVIDER','UNISWAP_ROUTER','SUSHISWAP_ROUTER','RPC_URL','PRIVATE_KEY'];
vars.forEach(v=>{
  const val = process.env[v];
  console.log(v+': '+(val?('set '+ (val.length>10? val.slice(0,6)+'...' : val) ):'UNSET'));
});
