/**
 * Web3 On-Chain Contract Dispatch via AFNCommissionSplitter
 */
export async function executeWeb3ContractPayment(
  orderId: string,
  wallet: string | null
): Promise<string | null> {
  if (typeof window === 'undefined' || typeof (window as any).ethereum === 'undefined') {
    return null;
  }

  try {
    const ethereum = (window as any).ethereum;
    const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
    const fromAccount = (accounts && accounts.length > 0) ? accounts[0] : (wallet || '');
    
    // Contract: AFNCommissionSplitter (Sepolia / Base Sepolia)
    const splitterContract = '0x62CdE41CB588Da5d9D748D6679e928b955264A43';
    const devAddress = '0xBd00c6C80832784418E620fb6FcDf5442424caD3'; // Genesis Developer
    const fnSelector = '0x7dee89d6'; // settleTaskPayment(bytes32,address)
    
    // Convert orderId string to 32-byte hex
    let orderHex = '';
    for (let i = 0; i < orderId.length; i++) {
      orderHex += orderId.charCodeAt(i).toString(16).padStart(2, '0');
    }
    const taskIdBytes32 = orderHex.padEnd(64, '0');
    const cleanDev = devAddress.toLowerCase().replace('0x', '').padStart(64, '0');
    const callData = fnSelector + taskIdBytes32 + cleanDev;
    const valueWeiHex = '0x2441400000000'; // ~0.00004 ETH (~$0.10 USD)

    const txHash = await ethereum.request({
      method: 'eth_sendTransaction',
      params: [{
        from: fromAccount,
        to: splitterContract,
        data: callData,
        value: valueWeiHex
      }]
    });

    return txHash as string;
  } catch (contractErr) {
    console.warn('Web3 on-chain settlement fallback:', contractErr);
    return null;
  }
}
