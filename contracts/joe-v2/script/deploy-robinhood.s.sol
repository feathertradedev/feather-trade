// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "forge-std/Script.sol";

import {IERC20, LBPair} from "src/LBPair.sol";
import {IJoeFactory} from "src/interfaces/IJoeFactory.sol";
import {ILBFactory, LBFactory} from "src/LBFactory.sol";
import {ILBLegacyFactory} from "src/interfaces/ILBLegacyFactory.sol";
import {ILBLegacyRouter} from "src/interfaces/ILBLegacyRouter.sol";
import {LBRouter} from "src/LBRouter.sol";
import {IWNATIVE} from "src/interfaces/IWNATIVE.sol";
import {LBQuoter} from "src/LBQuoter.sol";

contract RobinhoodDeployScript is Script {
    uint256 private constant ROBINHOOD_MAINNET_CHAIN_ID = 4_663;
    uint256 private constant ROBINHOOD_TESTNET_CHAIN_ID = 46_630;
    uint256 private constant PLACEHOLDER_PRIVATE_KEY =
        0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    address private constant ROBINHOOD_MAINNET_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address private constant ROBINHOOD_MAINNET_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address private constant ROBINHOOD_TESTNET_WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;

    uint256 private constant FLASHLOAN_FEE = 5e12;
    uint16 private constant DEFAULT_BIN_STEP = 10;
    uint16 private constant DEFAULT_BASE_FACTOR = 10_000;
    uint16 private constant DEFAULT_FILTER_PERIOD = 30;
    uint16 private constant DEFAULT_DECAY_PERIOD = 600;
    uint16 private constant DEFAULT_REDUCTION_FACTOR = 5_000;
    uint24 private constant DEFAULT_VARIABLE_FEE_CONTROL = 40_000;
    uint16 private constant DEFAULT_PROTOCOL_SHARE = 0;
    uint24 private constant DEFAULT_MAX_VOLATILITY_ACCUMULATOR = 350_000;
    bool private constant DEFAULT_OPEN_STATE = true;

    struct Deployment {
        address deployer;
        uint256 startBlock;
        IWNATIVE wrappedNative;
        LBFactory factory;
        LBPair pairImplementation;
        LBRouter router;
        LBQuoter quoter;
        address extraQuoteAsset0;
        address extraQuoteAsset1;
        address extraQuoteAsset2;
        address extraQuoteAsset3;
    }

    function run() external returns (Deployment memory deployment) {
        uint256 expectedChainId = _expectedChainId();
        if (block.chainid != expectedChainId) {
            revert(
                string.concat(
                    "ROBINHOOD_WRONG_CHAIN_ID expected=",
                    vm.toString(expectedChainId),
                    " actual=",
                    vm.toString(block.chainid)
                )
            );
        }

        uint256 deployerKey = _deployerKey();
        address deployer = vm.addr(deployerKey);
        string memory environment = _environmentName();
        string memory manifestPath = _manifestPath(environment);

        deployment.deployer = deployer;
        deployment.startBlock = block.number;
        deployment.wrappedNative = IWNATIVE(_wrappedNativeAddress());

        vm.startBroadcast(deployerKey);

        deployment.factory = new LBFactory(deployer, deployer, FLASHLOAN_FEE);
        deployment.pairImplementation = new LBPair(deployment.factory);
        deployment.router = new LBRouter(
            deployment.factory,
            IJoeFactory(address(0)),
            ILBLegacyFactory(address(0)),
            ILBLegacyRouter(address(0)),
            ILBFactory(address(0)),
            deployment.wrappedNative
        );
        deployment.quoter = new LBQuoter(
            address(0),
            address(0),
            address(0),
            address(deployment.factory),
            address(0),
            address(0),
            address(deployment.router)
        );

        _configureFactory(deployment);
        vm.stopBroadcast();

        _assertDeployed(deployment);
        _writeManifest(manifestPath, environment, deployment);

        console.log("Robinhood LB v2.2 deployment manifest:", manifestPath);
        console.log("Environment:", environment);
        console.log("Chain ID:", block.chainid);
        console.log("WrappedNative:", address(deployment.wrappedNative));
        console.log("LBFactory:", address(deployment.factory));
        console.log("LBRouter:", address(deployment.router));
        console.log("LBQuoter:", address(deployment.quoter));
    }

    function _deployerKey() private view returns (uint256 deployerKey) {
        deployerKey = vm.envOr("ROBINHOOD_DEPLOYER_PRIVATE_KEY", uint256(0));
        if (deployerKey == 0) deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));

        if (deployerKey == 0 || deployerKey == PLACEHOLDER_PRIVATE_KEY) {
            revert("ROBINHOOD_PRIVATE_KEY_REQUIRED");
        }
    }

    function _expectedChainId() private view returns (uint256) {
        uint256 defaultChainId =
            block.chainid == ROBINHOOD_MAINNET_CHAIN_ID ? ROBINHOOD_MAINNET_CHAIN_ID : ROBINHOOD_TESTNET_CHAIN_ID;

        return vm.envOr("ROBINHOOD_EXPECTED_CHAIN_ID", defaultChainId);
    }

    function _environmentName() private view returns (string memory) {
        return vm.envOr("ROBINHOOD_DEPLOYMENT_ENV", _defaultEnvironmentName());
    }

    function _defaultEnvironmentName() private view returns (string memory) {
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) return "mainnet";
        if (block.chainid == ROBINHOOD_TESTNET_CHAIN_ID) return "testnet";

        return "unknown";
    }

    function _manifestPath(string memory environment) private view returns (string memory) {
        string memory defaultPath =
            string.concat(vm.projectRoot(), "/deployments/robinhood/", environment, "/latest.json");
        string memory configuredPath = vm.envOr("ROBINHOOD_MANIFEST_PATH", defaultPath);

        return bytes(configuredPath).length == 0 ? defaultPath : configuredPath;
    }

    function _configureFactory(Deployment memory deployment) private {
        deployment.factory.setLBPairImplementation(address(deployment.pairImplementation));
        deployment.factory.addQuoteAsset(deployment.wrappedNative);
        deployment.factory
            .setPreset(
                DEFAULT_BIN_STEP,
                DEFAULT_BASE_FACTOR,
                DEFAULT_FILTER_PERIOD,
                DEFAULT_DECAY_PERIOD,
                DEFAULT_REDUCTION_FACTOR,
                DEFAULT_VARIABLE_FEE_CONTROL,
                DEFAULT_PROTOCOL_SHARE,
                DEFAULT_MAX_VOLATILITY_ACCUMULATOR,
                DEFAULT_OPEN_STATE
            );

        deployment.extraQuoteAsset0 =
            _addOptionalQuoteAsset(deployment.factory, "ROBINHOOD_QUOTE_ASSET_0", _defaultQuoteAsset0());
        deployment.extraQuoteAsset1 = _addOptionalQuoteAsset(deployment.factory, "ROBINHOOD_QUOTE_ASSET_1", address(0));
        deployment.extraQuoteAsset2 = _addOptionalQuoteAsset(deployment.factory, "ROBINHOOD_QUOTE_ASSET_2", address(0));
        deployment.extraQuoteAsset3 = _addOptionalQuoteAsset(deployment.factory, "ROBINHOOD_QUOTE_ASSET_3", address(0));
    }

    function _addOptionalQuoteAsset(LBFactory factory, string memory envKey, address defaultQuoteAsset)
        private
        returns (address quoteAsset)
    {
        quoteAsset = vm.envOr(envKey, defaultQuoteAsset);

        if (quoteAsset != address(0)) {
            if (quoteAsset.code.length == 0) revert("ROBINHOOD_QUOTE_ASSET_NOT_DEPLOYED");
            if (!factory.isQuoteAsset(IERC20(quoteAsset))) {
                factory.addQuoteAsset(IERC20(quoteAsset));
            }
        }
    }

    function _defaultQuoteAsset0() private view returns (address) {
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) return ROBINHOOD_MAINNET_USDG;

        return address(0);
    }

    function _assertDeployed(Deployment memory deployment) private view {
        if (address(deployment.wrappedNative).code.length == 0) revert("ROBINHOOD_WNATIVE_NOT_DEPLOYED");
        if (address(deployment.factory).code.length == 0) revert("ROBINHOOD_FACTORY_NOT_DEPLOYED");
        if (address(deployment.pairImplementation).code.length == 0) revert("ROBINHOOD_PAIR_IMPL_NOT_DEPLOYED");
        if (address(deployment.router).code.length == 0) revert("ROBINHOOD_ROUTER_NOT_DEPLOYED");
        if (address(deployment.quoter).code.length == 0) revert("ROBINHOOD_QUOTER_NOT_DEPLOYED");
        if (address(deployment.wrappedNative).code.length == 0) revert("ROBINHOOD_WNATIVE_NOT_FOUND");
    }

    function _writeManifest(string memory manifestPath, string memory environment, Deployment memory deployment)
        private
    {
        vm.createDir(string.concat(vm.projectRoot(), "/deployments/robinhood/", environment), true);

        _writeRoot(manifestPath, environment, deployment);
        _writeChain(manifestPath);
        _writeContracts(manifestPath, deployment);
        _writeOwnership(manifestPath, deployment);
        _writeEndpoints(manifestPath);
        _writeTokens(manifestPath, deployment);
        _writeQuoteAssets(manifestPath, deployment);
        _writePreset(manifestPath);
        _writeConstructorArgs(manifestPath, deployment);
    }

    function _writeRoot(string memory manifestPath, string memory environment, Deployment memory deployment) private {
        string memory root = "robinhood-root";
        vm.serializeString(root, "schemaVersion", "lb.robinhood.v1");
        vm.serializeString(root, "environment", environment);
        vm.serializeString(root, "sourceJoeV2Commit", "067c6ccf5b8ff1526d03fa3e4c65ec45d01c1f73");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "startBlock", deployment.startBlock);
        string memory rootJson = vm.serializeAddress(root, "deployer", deployment.deployer);
        vm.writeJson(rootJson, manifestPath);
    }

    function _writeChain(string memory manifestPath) private {
        string memory chainObject = "robinhood-chain";
        vm.serializeString(chainObject, "name", _chainName());
        vm.serializeString(chainObject, "nativeCurrency", "ETH");
        vm.serializeString(chainObject, "rpcEnvVar", _rpcEnvVar());
        vm.serializeString(chainObject, "explorerUrl", _explorerUrl());
        string memory chainJson = vm.serializeString(chainObject, "verifierUrl", _verifierUrl());
        vm.writeJson(chainJson, manifestPath, ".chain");
    }

    function _writeContracts(string memory manifestPath, Deployment memory deployment) private {
        string memory contractsObject = "robinhood-contracts";
        vm.serializeAddress(contractsObject, "lbFactory", address(deployment.factory));
        vm.serializeAddress(contractsObject, "lbPairImplementation", address(deployment.pairImplementation));
        vm.serializeAddress(contractsObject, "lbRouter", address(deployment.router));
        string memory contractsJson = vm.serializeAddress(contractsObject, "lbQuoter", address(deployment.quoter));
        vm.writeJson(contractsJson, manifestPath, ".contracts");
    }

    function _writeOwnership(string memory manifestPath, Deployment memory deployment) private {
        string memory ownershipObject = "robinhood-ownership";
        vm.serializeAddress(ownershipObject, "feeRecipient", deployment.deployer);
        vm.serializeAddress(ownershipObject, "initialOwner", deployment.deployer);
        string memory ownershipJson = vm.serializeAddress(ownershipObject, "lbFactoryOwner", deployment.deployer);
        vm.writeJson(ownershipJson, manifestPath, ".ownership");
    }

    function _writeEndpoints(string memory manifestPath) private {
        string memory endpointObject = "robinhood-endpoints";
        string memory endpointJson = vm.serializeString(endpointObject, "rpcUrl", _rpcUrl());
        string memory indexerUrl = vm.envOr("ROBINHOOD_INDEXER_URL", string(""));
        if (bytes(indexerUrl).length != 0) {
            endpointJson = vm.serializeString(endpointObject, "indexerUrl", indexerUrl);
        }
        string memory apiUrl = vm.envOr("ROBINHOOD_API_URL", string(""));
        if (bytes(apiUrl).length != 0) {
            endpointJson = vm.serializeString(endpointObject, "apiUrl", apiUrl);
        }
        string memory tokenListUrl = vm.envOr("ROBINHOOD_TOKEN_LIST_URL", string(""));
        if (bytes(tokenListUrl).length != 0) {
            endpointJson = vm.serializeString(endpointObject, "tokenListUrl", tokenListUrl);
        }
        vm.writeJson(endpointJson, manifestPath, ".endpoints");
    }

    function _writeTokens(string memory manifestPath, Deployment memory deployment) private {
        string memory tokensObject = "robinhood-tokens";
        string memory tokensJson = vm.serializeAddress(tokensObject, "wrappedNative", address(deployment.wrappedNative));
        vm.writeJson(tokensJson, manifestPath, ".tokens");
    }

    function _writeQuoteAssets(string memory manifestPath, Deployment memory deployment) private {
        string memory quoteAssetsObject = "robinhood-quote-assets";
        vm.serializeAddress(quoteAssetsObject, "wrappedNative", address(deployment.wrappedNative));
        vm.serializeAddress(quoteAssetsObject, "extra0", deployment.extraQuoteAsset0);
        vm.serializeAddress(quoteAssetsObject, "extra1", deployment.extraQuoteAsset1);
        vm.serializeAddress(quoteAssetsObject, "extra2", deployment.extraQuoteAsset2);
        string memory quoteAssetsJson = vm.serializeAddress(quoteAssetsObject, "extra3", deployment.extraQuoteAsset3);
        vm.writeJson(quoteAssetsJson, manifestPath, ".quoteAssets");
    }

    function _writePreset(string memory manifestPath) private {
        string memory presetObject = "robinhood-preset";
        vm.serializeUint(presetObject, "binStep", DEFAULT_BIN_STEP);
        vm.serializeUint(presetObject, "baseFactor", DEFAULT_BASE_FACTOR);
        vm.serializeUint(presetObject, "filterPeriod", DEFAULT_FILTER_PERIOD);
        vm.serializeUint(presetObject, "decayPeriod", DEFAULT_DECAY_PERIOD);
        vm.serializeUint(presetObject, "reductionFactor", DEFAULT_REDUCTION_FACTOR);
        vm.serializeUint(presetObject, "variableFeeControl", DEFAULT_VARIABLE_FEE_CONTROL);
        vm.serializeUint(presetObject, "protocolShare", DEFAULT_PROTOCOL_SHARE);
        vm.serializeUint(presetObject, "maxVolatilityAccumulator", DEFAULT_MAX_VOLATILITY_ACCUMULATOR);
        string memory presetJson = vm.serializeBool(presetObject, "open", DEFAULT_OPEN_STATE);
        vm.writeJson(presetJson, manifestPath, ".factoryPreset");
    }

    function _writeConstructorArgs(string memory manifestPath, Deployment memory deployment) private {
        string memory constructorObject = "robinhood-constructor-args";
        vm.serializeAddress(constructorObject, "feeRecipient", deployment.deployer);
        vm.serializeAddress(constructorObject, "initialOwner", deployment.deployer);
        vm.serializeUint(constructorObject, "flashLoanFee", FLASHLOAN_FEE);
        vm.serializeAddress(constructorObject, "routerFactoryV1", address(0));
        vm.serializeAddress(constructorObject, "routerLegacyFactoryV2", address(0));
        vm.serializeAddress(constructorObject, "routerLegacyRouterV2", address(0));
        vm.serializeAddress(constructorObject, "routerFactoryV2_1", address(0));
        vm.serializeAddress(constructorObject, "routerWNative", address(deployment.wrappedNative));
        vm.serializeAddress(constructorObject, "quoterFactoryV1", address(0));
        vm.serializeAddress(constructorObject, "quoterLegacyFactoryV2", address(0));
        vm.serializeAddress(constructorObject, "quoterFactoryV2_1", address(0));
        vm.serializeAddress(constructorObject, "quoterFactoryV2_2", address(deployment.factory));
        vm.serializeAddress(constructorObject, "quoterLegacyRouterV2", address(0));
        vm.serializeAddress(constructorObject, "quoterRouterV2_1", address(0));
        string memory constructorJson =
            vm.serializeAddress(constructorObject, "quoterRouterV2_2", address(deployment.router));
        vm.writeJson(constructorJson, manifestPath, ".constructorArgs");
    }

    function _chainName() private view returns (string memory) {
        return vm.envOr("ROBINHOOD_CHAIN_NAME", _defaultChainName());
    }

    function _defaultChainName() private view returns (string memory) {
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) return "Robinhood Chain";
        if (block.chainid == ROBINHOOD_TESTNET_CHAIN_ID) return "Robinhood Chain Testnet";

        return "Unknown Robinhood Chain Target";
    }

    function _rpcEnvVar() private view returns (string memory) {
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) return "ROBINHOOD_RPC_URL";
        if (block.chainid == ROBINHOOD_TESTNET_CHAIN_ID) return "ROBINHOOD_TESTNET_RPC_URL";

        return "ROBINHOOD_RPC_URL";
    }

    function _rpcUrl() private view returns (string memory) {
        return vm.envOr(_rpcEnvVar(), _defaultRpcUrl());
    }

    function _defaultRpcUrl() private view returns (string memory) {
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) return "https://rpc.mainnet.chain.robinhood.com";
        if (block.chainid == ROBINHOOD_TESTNET_CHAIN_ID) return "https://rpc.testnet.chain.robinhood.com";

        return "";
    }

    function _explorerUrl() private view returns (string memory) {
        return vm.envOr("ROBINHOOD_EXPLORER_URL", _defaultExplorerUrl());
    }

    function _defaultExplorerUrl() private view returns (string memory) {
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) return "https://robinhoodchain.blockscout.com";
        if (block.chainid == ROBINHOOD_TESTNET_CHAIN_ID) return "https://explorer.testnet.chain.robinhood.com";

        return "";
    }

    function _verifierUrl() private view returns (string memory) {
        return vm.envOr("ROBINHOOD_VERIFIER_URL", _defaultVerifierUrl());
    }

    function _defaultVerifierUrl() private view returns (string memory) {
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) return "https://robinhoodchain.blockscout.com/api/";
        if (block.chainid == ROBINHOOD_TESTNET_CHAIN_ID) return "https://explorer.testnet.chain.robinhood.com/api/";

        return "";
    }

    function _wrappedNativeAddress() private view returns (address) {
        address configured = vm.envOr("ROBINHOOD_WNATIVE_ADDRESS", address(0));
        if (configured != address(0)) return configured;

        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) return ROBINHOOD_MAINNET_WETH;
        if (block.chainid == ROBINHOOD_TESTNET_CHAIN_ID) return ROBINHOOD_TESTNET_WETH;

        revert("ROBINHOOD_WNATIVE_ADDRESS_REQUIRED");
    }
}
