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

/// @notice Deploys a fresh, V2.2-only Liquidity Book core to an explicitly selected EVM chain.
/// @dev This script deliberately does not deploy tokens, create pools, seed liquidity, or hand off ownership.
contract GenericEvmDeployScript is Script {
    uint256 private constant PLACEHOLDER_PRIVATE_KEY =
        0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

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
        uint256 expectedChainId = vm.envUint("EVM_DEPLOY_EXPECTED_CHAIN_ID");
        if (expectedChainId == 0) revert("EVM_DEPLOY_EXPECTED_CHAIN_ID_INVALID");
        if (block.chainid != expectedChainId) {
            revert(
                string.concat(
                    "EVM_DEPLOY_WRONG_CHAIN_ID expected=",
                    vm.toString(expectedChainId),
                    " actual=",
                    vm.toString(block.chainid)
                )
            );
        }

        uint256 deployerKey = _deployerKey();
        address deployer = vm.addr(deployerKey);
        string memory network = vm.envString("EVM_DEPLOY_NETWORK");
        _requireSafeSlug(network, "EVM_DEPLOY_NETWORK_INVALID");

        string memory sourceCommit = vm.envString("EVM_DEPLOY_SOURCE_COMMIT");
        _requireGitCommit(sourceCommit);

        address wrappedNativeAddress = vm.envAddress("EVM_DEPLOY_WNATIVE_ADDRESS");
        _requireDeployedAddress(wrappedNativeAddress, "EVM_DEPLOY_WNATIVE_NOT_DEPLOYED");

        deployment.deployer = deployer;
        deployment.startBlock = block.number;
        deployment.wrappedNative = IWNATIVE(wrappedNativeAddress);
        deployment.extraQuoteAsset0 = _optionalQuoteAsset("EVM_DEPLOY_QUOTE_ASSET_0");
        deployment.extraQuoteAsset1 = _optionalQuoteAsset("EVM_DEPLOY_QUOTE_ASSET_1");
        deployment.extraQuoteAsset2 = _optionalQuoteAsset("EVM_DEPLOY_QUOTE_ASSET_2");
        deployment.extraQuoteAsset3 = _optionalQuoteAsset("EVM_DEPLOY_QUOTE_ASSET_3");
        _assertDistinctQuoteAssets(deployment);

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

        _assertDeployment(deployment);

        string memory manifestPath = _manifestPath(network);
        _writeManifest(manifestPath, network, sourceCommit, deployment);

        console.log("Generic EVM LB v2.2 deployment manifest:", manifestPath);
        console.log("Environment:", network);
        console.log("Chain ID:", block.chainid);
        console.log("Wrapped native:", address(deployment.wrappedNative));
        console.log("LBFactory:", address(deployment.factory));
        console.log("LBPair implementation:", address(deployment.pairImplementation));
        console.log("LBRouter:", address(deployment.router));
        console.log("LBQuoter:", address(deployment.quoter));
    }

    function _deployerKey() private view returns (uint256 deployerKey) {
        deployerKey = vm.envOr("EVM_DEPLOYER_PRIVATE_KEY", uint256(0));
        if (deployerKey == 0) deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));

        if (deployerKey == 0 || deployerKey == PLACEHOLDER_PRIVATE_KEY) {
            revert("EVM_DEPLOY_PRIVATE_KEY_REQUIRED");
        }
    }

    function _optionalQuoteAsset(string memory envKey) private view returns (address quoteAsset) {
        quoteAsset = vm.envOr(envKey, address(0));
        if (quoteAsset != address(0)) {
            _requireDeployedAddress(quoteAsset, "EVM_DEPLOY_QUOTE_ASSET_NOT_DEPLOYED");
        }
    }

    function _assertDistinctQuoteAssets(Deployment memory deployment) private pure {
        address[5] memory quoteAssets = [
            address(deployment.wrappedNative),
            deployment.extraQuoteAsset0,
            deployment.extraQuoteAsset1,
            deployment.extraQuoteAsset2,
            deployment.extraQuoteAsset3
        ];

        for (uint256 i; i < quoteAssets.length; ++i) {
            if (quoteAssets[i] == address(0)) continue;
            for (uint256 j = i + 1; j < quoteAssets.length; ++j) {
                if (quoteAssets[i] == quoteAssets[j]) revert("EVM_DEPLOY_DUPLICATE_QUOTE_ASSET");
            }
        }
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

        _addOptionalQuoteAsset(deployment.factory, deployment.extraQuoteAsset0);
        _addOptionalQuoteAsset(deployment.factory, deployment.extraQuoteAsset1);
        _addOptionalQuoteAsset(deployment.factory, deployment.extraQuoteAsset2);
        _addOptionalQuoteAsset(deployment.factory, deployment.extraQuoteAsset3);
    }

    function _addOptionalQuoteAsset(LBFactory factory, address quoteAsset) private {
        if (quoteAsset != address(0)) factory.addQuoteAsset(IERC20(quoteAsset));
    }

    function _assertDeployment(Deployment memory deployment) private view {
        _requireDeployedAddress(address(deployment.factory), "EVM_DEPLOY_FACTORY_NOT_DEPLOYED");
        _requireDeployedAddress(address(deployment.pairImplementation), "EVM_DEPLOY_PAIR_IMPL_NOT_DEPLOYED");
        _requireDeployedAddress(address(deployment.router), "EVM_DEPLOY_ROUTER_NOT_DEPLOYED");
        _requireDeployedAddress(address(deployment.quoter), "EVM_DEPLOY_QUOTER_NOT_DEPLOYED");

        if (deployment.factory.owner() != deployment.deployer) revert("EVM_DEPLOY_FACTORY_OWNER_MISMATCH");
        if (deployment.factory.pendingOwner() != address(0)) revert("EVM_DEPLOY_FACTORY_PENDING_OWNER");
        if (deployment.factory.getFeeRecipient() != deployment.deployer) {
            revert("EVM_DEPLOY_FEE_RECIPIENT_MISMATCH");
        }
        if (deployment.factory.getFlashLoanFee() != FLASHLOAN_FEE) revert("EVM_DEPLOY_FLASHLOAN_FEE_MISMATCH");
        if (deployment.factory.getLBPairImplementation() != address(deployment.pairImplementation)) {
            revert("EVM_DEPLOY_PAIR_IMPL_MISMATCH");
        }
        if (address(deployment.pairImplementation.getFactory()) != address(deployment.factory)) {
            revert("EVM_DEPLOY_PAIR_IMPL_FACTORY_MISMATCH");
        }

        if (address(deployment.router.getFactory()) != address(deployment.factory)) {
            revert("EVM_DEPLOY_ROUTER_FACTORY_MISMATCH");
        }
        if (address(deployment.router.getFactoryV2_1()) != address(0)) revert("EVM_DEPLOY_ROUTER_V2_1_ENABLED");
        if (address(deployment.router.getV1Factory()) != address(0)) revert("EVM_DEPLOY_ROUTER_V1_ENABLED");
        if (address(deployment.router.getLegacyFactory()) != address(0)) {
            revert("EVM_DEPLOY_ROUTER_LEGACY_FACTORY_ENABLED");
        }
        if (address(deployment.router.getLegacyRouter()) != address(0)) {
            revert("EVM_DEPLOY_ROUTER_LEGACY_ROUTER_ENABLED");
        }
        if (address(deployment.router.getWNATIVE()) != address(deployment.wrappedNative)) {
            revert("EVM_DEPLOY_ROUTER_WNATIVE_MISMATCH");
        }

        if (deployment.quoter.getFactoryV1() != address(0)) revert("EVM_DEPLOY_QUOTER_V1_ENABLED");
        if (deployment.quoter.getLegacyFactoryV2() != address(0)) revert("EVM_DEPLOY_QUOTER_LEGACY_FACTORY_ENABLED");
        if (deployment.quoter.getFactoryV2_1() != address(0)) revert("EVM_DEPLOY_QUOTER_V2_1_ENABLED");
        if (deployment.quoter.getFactoryV2_2() != address(deployment.factory)) {
            revert("EVM_DEPLOY_QUOTER_FACTORY_MISMATCH");
        }
        if (deployment.quoter.getLegacyRouterV2() != address(0)) revert("EVM_DEPLOY_QUOTER_LEGACY_ROUTER_ENABLED");
        if (deployment.quoter.getRouterV2_1() != address(0)) revert("EVM_DEPLOY_QUOTER_ROUTER_V2_1_ENABLED");
        if (deployment.quoter.getRouterV2_2() != address(deployment.router)) {
            revert("EVM_DEPLOY_QUOTER_ROUTER_MISMATCH");
        }

        _assertQuoteAsset(deployment.factory, address(deployment.wrappedNative));
        _assertQuoteAsset(deployment.factory, deployment.extraQuoteAsset0);
        _assertQuoteAsset(deployment.factory, deployment.extraQuoteAsset1);
        _assertQuoteAsset(deployment.factory, deployment.extraQuoteAsset2);
        _assertQuoteAsset(deployment.factory, deployment.extraQuoteAsset3);

        uint256 expectedQuoteAssetCount = 1;
        if (deployment.extraQuoteAsset0 != address(0)) ++expectedQuoteAssetCount;
        if (deployment.extraQuoteAsset1 != address(0)) ++expectedQuoteAssetCount;
        if (deployment.extraQuoteAsset2 != address(0)) ++expectedQuoteAssetCount;
        if (deployment.extraQuoteAsset3 != address(0)) ++expectedQuoteAssetCount;
        if (deployment.factory.getNumberOfQuoteAssets() != expectedQuoteAssetCount) {
            revert("EVM_DEPLOY_QUOTE_ASSET_COUNT_MISMATCH");
        }

        (
            uint256 baseFactor,
            uint256 filterPeriod,
            uint256 decayPeriod,
            uint256 reductionFactor,
            uint256 variableFeeControl,
            uint256 protocolShare,
            uint256 maxVolatilityAccumulator,
            bool open
        ) = deployment.factory.getPreset(DEFAULT_BIN_STEP);
        if (
            baseFactor != DEFAULT_BASE_FACTOR || filterPeriod != DEFAULT_FILTER_PERIOD
                || decayPeriod != DEFAULT_DECAY_PERIOD || reductionFactor != DEFAULT_REDUCTION_FACTOR
                || variableFeeControl != DEFAULT_VARIABLE_FEE_CONTROL || protocolShare != DEFAULT_PROTOCOL_SHARE
                || maxVolatilityAccumulator != DEFAULT_MAX_VOLATILITY_ACCUMULATOR || open != DEFAULT_OPEN_STATE
        ) revert("EVM_DEPLOY_PRESET_MISMATCH");
    }

    function _assertQuoteAsset(LBFactory factory, address quoteAsset) private view {
        if (quoteAsset != address(0) && !factory.isQuoteAsset(IERC20(quoteAsset))) {
            revert("EVM_DEPLOY_QUOTE_ASSET_MISSING");
        }
    }

    function _requireDeployedAddress(address value, string memory reason) private view {
        if (value == address(0) || value.code.length == 0) revert(reason);
    }

    function _requireSafeSlug(string memory value, string memory reason) private pure {
        bytes memory raw = bytes(value);
        if (raw.length == 0 || raw.length > 64) revert(reason);

        for (uint256 i; i < raw.length; ++i) {
            bytes1 character = raw[i];
            bool valid =
                (character >= 0x30 && character <= 0x39) || (character >= 0x61 && character <= 0x7a)
                || character == 0x2d;
            if (!valid) revert(reason);
        }
    }

    function _requireGitCommit(string memory value) private pure {
        bytes memory raw = bytes(value);
        if (raw.length != 40) revert("EVM_DEPLOY_SOURCE_COMMIT_INVALID");

        for (uint256 i; i < raw.length; ++i) {
            bytes1 character = raw[i];
            bool valid =
                (character >= 0x30 && character <= 0x39) || (character >= 0x41 && character <= 0x46)
                || (character >= 0x61 && character <= 0x66);
            if (!valid) revert("EVM_DEPLOY_SOURCE_COMMIT_INVALID");
        }
    }

    function _manifestPath(string memory network) private view returns (string memory) {
        string memory defaultPath = string.concat(vm.projectRoot(), "/deployments/evm/", network, "/latest.json");
        string memory configuredPath = vm.envOr("EVM_DEPLOY_MANIFEST_PATH", defaultPath);
        return bytes(configuredPath).length == 0 ? defaultPath : configuredPath;
    }

    function _writeManifest(
        string memory manifestPath,
        string memory network,
        string memory sourceCommit,
        Deployment memory deployment
    ) private {
        _createParentDirectory(manifestPath);

        _writeRoot(manifestPath, network, sourceCommit, deployment);
        _writeChain(manifestPath, network);
        _writeContracts(manifestPath, deployment);
        _writeOwnership(manifestPath, deployment);
        _writeTokens(manifestPath, deployment);
        _writeQuoteAssets(manifestPath, deployment);
        _writePreset(manifestPath);
        _writeConstructorArgs(manifestPath, deployment);
    }

    function _writeRoot(
        string memory manifestPath,
        string memory network,
        string memory sourceCommit,
        Deployment memory deployment
    ) private {
        string memory root = "evm-root";
        vm.serializeString(root, "schemaVersion", "lb.evm.v1");
        vm.serializeString(root, "environment", network);
        vm.serializeString(root, "sourceCommit", sourceCommit);
        vm.serializeBool(root, "sourceTreeDirty", vm.envOr("EVM_DEPLOY_SOURCE_TREE_DIRTY", false));
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "startBlock", deployment.startBlock);
        string memory rootJson = vm.serializeAddress(root, "deployer", deployment.deployer);
        vm.writeJson(rootJson, manifestPath);
    }

    function _writeChain(string memory manifestPath, string memory network) private {
        string memory chainName = vm.envOr("EVM_DEPLOY_CHAIN_NAME", network);
        string memory nativeCurrency = vm.envOr("EVM_DEPLOY_NATIVE_CURRENCY", string("ETH"));
        string memory rpcEnvVar = vm.envOr("EVM_DEPLOY_RPC_ENV_VAR", string("EVM_DEPLOY_RPC_URL"));
        if (bytes(chainName).length == 0) revert("EVM_DEPLOY_CHAIN_NAME_INVALID");
        if (bytes(nativeCurrency).length == 0) revert("EVM_DEPLOY_NATIVE_CURRENCY_INVALID");
        _requireEnvVarName(rpcEnvVar);

        string memory chainObject = "evm-chain";
        vm.serializeString(chainObject, "name", chainName);
        vm.serializeString(chainObject, "nativeCurrency", nativeCurrency);
        vm.serializeString(chainObject, "rpcEnvVar", rpcEnvVar);
        vm.serializeString(chainObject, "explorerUrl", vm.envOr("EVM_DEPLOY_EXPLORER_URL", string("")));
        string memory chainJson =
            vm.serializeString(chainObject, "verifierUrl", vm.envOr("EVM_DEPLOY_VERIFIER_URL", string("")));
        vm.writeJson(chainJson, manifestPath, ".chain");
    }

    function _requireEnvVarName(string memory value) private pure {
        bytes memory raw = bytes(value);
        if (raw.length == 0 || raw.length > 128) revert("EVM_DEPLOY_RPC_ENV_VAR_INVALID");

        for (uint256 i; i < raw.length; ++i) {
            bytes1 character = raw[i];
            bool valid =
                (character >= 0x41 && character <= 0x5a) || (character >= 0x61 && character <= 0x7a)
                || character == 0x5f || (i > 0 && character >= 0x30 && character <= 0x39);
            if (!valid) revert("EVM_DEPLOY_RPC_ENV_VAR_INVALID");
        }
    }

    function _writeContracts(string memory manifestPath, Deployment memory deployment) private {
        string memory contractsObject = "evm-contracts";
        vm.serializeAddress(contractsObject, "lbFactory", address(deployment.factory));
        vm.serializeAddress(contractsObject, "lbPairImplementation", address(deployment.pairImplementation));
        vm.serializeAddress(contractsObject, "lbRouter", address(deployment.router));
        string memory contractsJson = vm.serializeAddress(contractsObject, "lbQuoter", address(deployment.quoter));
        vm.writeJson(contractsJson, manifestPath, ".contracts");
    }

    function _writeOwnership(string memory manifestPath, Deployment memory deployment) private {
        string memory ownershipObject = "evm-ownership";
        vm.serializeAddress(ownershipObject, "feeRecipient", deployment.deployer);
        vm.serializeAddress(ownershipObject, "initialOwner", deployment.deployer);
        string memory ownershipJson = vm.serializeAddress(ownershipObject, "lbFactoryOwner", deployment.deployer);
        vm.writeJson(ownershipJson, manifestPath, ".ownership");
    }

    function _writeTokens(string memory manifestPath, Deployment memory deployment) private {
        string memory tokensObject = "evm-tokens";
        string memory tokensJson = vm.serializeAddress(tokensObject, "wrappedNative", address(deployment.wrappedNative));
        vm.writeJson(tokensJson, manifestPath, ".tokens");
    }

    function _writeQuoteAssets(string memory manifestPath, Deployment memory deployment) private {
        string memory quoteAssetsObject = "evm-quote-assets";
        vm.serializeAddress(quoteAssetsObject, "wrappedNative", address(deployment.wrappedNative));
        vm.serializeAddress(quoteAssetsObject, "extra0", deployment.extraQuoteAsset0);
        vm.serializeAddress(quoteAssetsObject, "extra1", deployment.extraQuoteAsset1);
        vm.serializeAddress(quoteAssetsObject, "extra2", deployment.extraQuoteAsset2);
        string memory quoteAssetsJson = vm.serializeAddress(quoteAssetsObject, "extra3", deployment.extraQuoteAsset3);
        vm.writeJson(quoteAssetsJson, manifestPath, ".quoteAssets");
    }

    function _writePreset(string memory manifestPath) private {
        string memory presetObject = "evm-preset";
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
        string memory constructorObject = "evm-constructor-args";
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

    function _createParentDirectory(string memory path) private {
        bytes memory raw = bytes(path);
        uint256 slashIndex = type(uint256).max;
        for (uint256 i; i < raw.length; ++i) {
            if (raw[i] == 0x2f) slashIndex = i;
        }

        if (slashIndex == type(uint256).max || slashIndex == 0) return;

        bytes memory parent = new bytes(slashIndex);
        for (uint256 i; i < slashIndex; ++i) {
            parent[i] = raw[i];
        }
        vm.createDir(string(parent), true);
    }
}
