import { ContractWrappers, ERC20TokenContract, Order, SignedOrder, ZeroExTransaction } from '@0x/contract-wrappers';
import { generatePseudoRandomSalt, orderHashUtils, signatureUtils, transactionHashUtils } from '@0x/order-utils';
import { BigNumber } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';

import { NETWORK_CONFIGS, TX_DEFAULTS } from '../configs';
import { DECIMALS, NULL_ADDRESS, NULL_BYTES, UNLIMITED_ALLOWANCE_IN_BASE_UNITS, ZERO } from '../constants';
import { contractAddresses } from '../contracts';
import { PrintUtils } from '../print_utils';
import { providerEngine } from '../provider_engine';
import { getRandomFutureDateInSeconds, runMigrationsOnceIfRequiredAsync } from '../utils';

/**
 * In this scenario a third party, called the sender, submits the operation on behalf of the taker.
 * This allows a sender to pay the gas on for the taker. It can be combined with a custom sender
 * contract with additional business logic (e.g checking a whitelist). Or the sender
 * can choose how and when the transaction should be submitted, if at all.
 * The maker creates and signs the order. The signed order and fillOrder parameters for the
 * execute transaction function call are signed by the taker.
 */
export async function scenarioAsync(): Promise<void> {
    await runMigrationsOnceIfRequiredAsync();
    PrintUtils.printScenario('Execute Transaction fillOrder');
    // Initialize the ContractWrappers, this provides helper functions around calling
    // 0x contracts as well as ERC20/ERC721 token contracts on the blockchain
    const contractWrappers = new ContractWrappers(providerEngine, { chainId: NETWORK_CONFIGS.chainId });
    // Initialize the Web3Wrapper, this provides helper functions around fetching
    // account information, balances, general contract logs
    const web3Wrapper = new Web3Wrapper(providerEngine);
    const [maker, taker, sender] = await web3Wrapper.getAvailableAddressesAsync();
    const feeRecipientAddress = sender;
    const zrxTokenAddress = contractAddresses.zrxToken;
    const etherTokenAddress = contractAddresses.etherToken;
    const printUtils = new PrintUtils(
        web3Wrapper,
        contractWrappers,
        { maker, taker, sender },
        { WETH: etherTokenAddress, ZRX: zrxTokenAddress },
    );
    printUtils.printAccounts();

    // the amount the maker is selling of maker asset
    const makerAssetAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(5), DECIMALS);
    // the amount the maker wants of taker asset
    const takerAssetAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(0.1), DECIMALS);
    // 0x v2 uses hex encoded asset data strings to encode all the information needed to identify an asset
    const makerAssetData = await contractWrappers.devUtils.encodeERC20AssetData.callAsync(zrxTokenAddress);
    const takerAssetData = await contractWrappers.devUtils.encodeERC20AssetData.callAsync(etherTokenAddress);
    let txHash;

    const zrxToken = new ERC20TokenContract(zrxTokenAddress, providerEngine);
    // Approve the ERC20 Proxy to move ZRX for maker
    const makerZRXApprovalTxHash = await zrxToken.approve.sendTransactionAsync(
        contractAddresses.erc20Proxy,
        UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
        { from: maker },
    );
    await printUtils.awaitTransactionMinedSpinnerAsync('Maker ZRX Approval', makerZRXApprovalTxHash);

    // Approve the ERC20 Proxy to move ZRX for taker
    const takerZRXApprovalTxHash = await zrxToken.approve.sendTransactionAsync(
        contractAddresses.erc20Proxy,
        UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
        { from: taker },
    );
    await printUtils.awaitTransactionMinedSpinnerAsync('Taker ZRX Approval', takerZRXApprovalTxHash);

    // Approve the ERC20 Proxy to move WETH for taker
    const takerWETHApprovalTxHash = await contractWrappers.weth9.approve.sendTransactionAsync(
        contractAddresses.erc20Proxy,
        UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
        { from: taker },
    );
    await printUtils.awaitTransactionMinedSpinnerAsync('Taker WETH Approval', takerWETHApprovalTxHash);

    // Convert ETH into WETH for taker by depositing ETH into the WETH contract
    const takerWETHDepositTxHash = await contractWrappers.weth9.deposit.sendTransactionAsync({
        from: taker,
        value: takerAssetAmount,
    });
    await printUtils.awaitTransactionMinedSpinnerAsync('Taker WETH Deposit', takerWETHDepositTxHash);

    PrintUtils.printData('Setup', [
        ['Maker ZRX Approval', makerZRXApprovalTxHash],
        ['Taker ZRX Approval', takerZRXApprovalTxHash],
        ['Taker WETH Approval', takerWETHApprovalTxHash],
        ['Taker WETH Deposit', takerWETHDepositTxHash],
    ]);

    // Set up the Order and fill it
    const randomExpiration = getRandomFutureDateInSeconds();

    // Create the order
    const order: Order = {
        chainId: NETWORK_CONFIGS.networkId,
        exchangeAddress: contractAddresses.exchange,
        makerAddress: maker,
        takerAddress: NULL_ADDRESS,
        senderAddress: NULL_ADDRESS,
        feeRecipientAddress: NULL_ADDRESS,
        expirationTimeSeconds: randomExpiration,
        salt: generatePseudoRandomSalt(),
        makerAssetAmount,
        takerAssetAmount,
        makerAssetData,
        takerAssetData,
        makerFeeAssetData: NULL_BYTES,
        takerFeeAssetData: NULL_BYTES,
        makerFee: ZERO,
        takerFee: ZERO,
    };

    printUtils.printOrder(order);

    // Print out the Balances and Allowances
    await printUtils.fetchAndPrintContractAllowancesAsync();
    await printUtils.fetchAndPrintContractBalancesAsync();

    // Generate the order hash and sign it
    const orderHashHex = orderHashUtils.getOrderHashHex(order);
    const signature = await signatureUtils.ecSignHashAsync(providerEngine, orderHashHex, maker);

    const signedOrder: SignedOrder = {
        ...order,
        signature,
    };

    // This is an ABI encoded function call that the taker wishes to perform
    // in this scenario it is a fillOrder
    const fillData = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(
        signedOrder,
        takerAssetAmount,
        signedOrder.signature,
    );
    // Generate a random salt to mitigate replay attacks
    const takerTransactionSalt = generatePseudoRandomSalt();
    // The taker signs the operation data (fillOrder) with the salt
    const zeroExTransaction: ZeroExTransaction = {
        data: fillData,
        salt: takerTransactionSalt,
        signerAddress: taker,
        gasPrice: new BigNumber(2000000000),
        expirationTimeSeconds: randomExpiration,
        domain: {
            chainId: NETWORK_CONFIGS.networkId,
            verifyingContract: contractAddresses.exchange,
        },
    };
    const executeTransactionHex = transactionHashUtils.getTransactionHashHex(zeroExTransaction);
    const takerSignatureHex = await signatureUtils.ecSignHashAsync(providerEngine, executeTransactionHex, taker);
    // The sender submits this operation via executeTransaction passing in the signature from the taker
    txHash = await contractWrappers.exchange.executeTransaction.sendTransactionAsync(
        zeroExTransaction,
        takerSignatureHex,
        {
            gas: TX_DEFAULTS.gas,
            from: sender,
        },
    );
    const txReceipt = await printUtils.awaitTransactionMinedSpinnerAsync('executeTransaction', txHash);
    printUtils.printTransaction('Execute Transaction fillOrder', txReceipt, [['orderHash', orderHashHex]]);

    // Print the Balances
    await printUtils.fetchAndPrintContractBalancesAsync();

    // Stop the Provider Engine
    providerEngine.stop();
}

void (async () => {
    try {
        if (!module.parent) {
            await scenarioAsync();
        }
    } catch (e) {
        console.log(e);
        providerEngine.stop();
        process.exit(1);
    }
})();
