// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "forge-std/Script.sol";

import {IERC20, LBPair} from "src/LBPair.sol";
import {IJoeFactory} from "src/interfaces/IJoeFactory.sol";
import {ILBFactory, LBFactory} from "src/LBFactory.sol";
import {ILBLegacyFactory} from "src/interfaces/ILBLegacyFactory.sol";
import {ILBLegacyRouter} from "src/interfaces/ILBLegacyRouter.sol";
import {ILBRouter, LBRouter} from "src/LBRouter.sol";
import {IWNATIVE} from "src/interfaces/IWNATIVE.sol";
import {LBQuoter} from "src/LBQuoter.sol";

import {ERC20Mock} from "test/mocks/ERC20.sol";
import {WNATIVE} from "test/mocks/WNATIVE.sol";

contract LocalnetDeployScript is Script {
    uint256 private constant ANVIL_ACCOUNT_0_PRIVATE_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    uint256 private constant FLASHLOAN_FEE = 5e12;
    uint24 private constant ID_ONE = 8_388_608;
    uint16 private constant DEFAULT_BIN_STEP = 10;
    uint16 private constant DEFAULT_BASE_FACTOR = 10_000;
    uint16 private constant DEFAULT_FILTER_PERIOD = 30;
    uint16 private constant DEFAULT_DECAY_PERIOD = 600;
    uint16 private constant DEFAULT_REDUCTION_FACTOR = 5_000;
    uint24 private constant DEFAULT_VARIABLE_FEE_CONTROL = 40_000;
    uint16 private constant DEFAULT_PROTOCOL_SHARE = 0;
    uint24 private constant DEFAULT_MAX_VOLATILITY_ACCUMULATOR = 350_000;
    bool private constant DEFAULT_OPEN_STATE = true;
    uint256 private constant DISTRIBUTION_PRECISION = 1e18;
    uint256 private constant TOKEN_MINT_AMOUNT = 1_000 ether;
    uint256 private constant LIQUIDITY_AMOUNT_X = 100 ether;
    uint256 private constant LIQUIDITY_AMOUNT_Y = 100 ether;
    uint256 private constant SWAP_AMOUNT_IN = 1 ether;
    string private constant DEFAULT_LOCALNET_RPC_URL = "http://127.0.0.1:8545";
    string private constant DEFAULT_LOCALNET_INDEXER_URL = "http://127.0.0.1:8000/subgraphs/name/robinhood-lb/localnet";
    string private constant DEFAULT_LOCALNET_API_URL = "http://127.0.0.1:3001";

    struct Deployment {
        address deployer;
        uint256 startBlock;
        WNATIVE wnative;
        ERC20Mock usdc;
        ERC20Mock usdt;
        ERC20Mock weth;
        LBFactory factory;
        LBPair pairImplementation;
        LBRouter router;
        LBQuoter quoter;
        LBPair wnativeUsdcPair;
        uint256 swapAmountOut;
    }

    function run() external returns (Deployment memory deployment) {
        uint256 deployerKey = vm.envOr("LOCALNET_PRIVATE_KEY", ANVIL_ACCOUNT_0_PRIVATE_KEY);
        address deployer = vm.addr(deployerKey);
        string memory manifestPath = _manifestPath();

        deployment.deployer = deployer;
        deployment.startBlock = block.number;

        vm.startBroadcast(deployerKey);

        deployment.wnative = new WNATIVE();
        deployment.usdc = new ERC20Mock(18);
        deployment.usdt = new ERC20Mock(18);
        deployment.weth = new ERC20Mock(18);

        deployment.factory = new LBFactory(deployer, deployer, FLASHLOAN_FEE);
        deployment.pairImplementation = new LBPair(deployment.factory);
        deployment.router = new LBRouter(
            deployment.factory,
            IJoeFactory(address(0)),
            ILBLegacyFactory(address(0)),
            ILBLegacyRouter(address(0)),
            ILBFactory(address(0)),
            IWNATIVE(address(deployment.wnative))
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
        _mintAndApprove(deployment);

        deployment.wnativeUsdcPair = LBPair(
            address(deployment.factory.createLBPair(deployment.wnative, deployment.usdc, ID_ONE, DEFAULT_BIN_STEP))
        );
        _addSmokeLiquidity(deployment);
        deployment.swapAmountOut = _executeSmokeSwap(deployment);

        vm.stopBroadcast();

        if (address(deployment.wnativeUsdcPair).code.length == 0) revert("LOCALNET_PAIR_NOT_DEPLOYED");
        if (deployment.swapAmountOut == 0) revert("LOCALNET_SWAP_ZERO_OUT");

        _writeManifest(manifestPath, deployment);

        console.log("Localnet LB v2.2 deployment manifest:", manifestPath);
        console.log("LBFactory:", address(deployment.factory));
        console.log("LBRouter:", address(deployment.router));
        console.log("LBQuoter:", address(deployment.quoter));
        console.log("WNATIVE/USDC pair:", address(deployment.wnativeUsdcPair));
        console.log("Smoke swap amount out:", deployment.swapAmountOut);
    }

    function _configureFactory(Deployment memory deployment) private {
        deployment.factory.setLBPairImplementation(address(deployment.pairImplementation));
        deployment.factory.addQuoteAsset(deployment.wnative);
        deployment.factory.addQuoteAsset(deployment.usdc);
        deployment.factory.addQuoteAsset(deployment.usdt);
        deployment.factory.addQuoteAsset(deployment.weth);
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
    }

    function _mintAndApprove(Deployment memory deployment) private {
        deployment.wnative.deposit{value: TOKEN_MINT_AMOUNT}();
        deployment.usdc.mint(deployment.deployer, TOKEN_MINT_AMOUNT);
        deployment.usdt.mint(deployment.deployer, TOKEN_MINT_AMOUNT);
        deployment.weth.mint(deployment.deployer, TOKEN_MINT_AMOUNT);

        deployment.wnative.approve(address(deployment.router), type(uint256).max);
        deployment.usdc.approve(address(deployment.router), type(uint256).max);
        deployment.usdt.approve(address(deployment.router), type(uint256).max);
        deployment.weth.approve(address(deployment.router), type(uint256).max);
    }

    function _addSmokeLiquidity(Deployment memory deployment) private {
        int256[] memory deltaIds = new int256[](1);
        uint256[] memory distributionX = new uint256[](1);
        uint256[] memory distributionY = new uint256[](1);

        distributionX[0] = DISTRIBUTION_PRECISION;
        distributionY[0] = DISTRIBUTION_PRECISION;

        ILBRouter.LiquidityParameters memory liquidityParameters = ILBRouter.LiquidityParameters({
            tokenX: deployment.wnative,
            tokenY: deployment.usdc,
            binStep: DEFAULT_BIN_STEP,
            amountX: LIQUIDITY_AMOUNT_X,
            amountY: LIQUIDITY_AMOUNT_Y,
            amountXMin: 0,
            amountYMin: 0,
            activeIdDesired: ID_ONE,
            idSlippage: 0,
            deltaIds: deltaIds,
            distributionX: distributionX,
            distributionY: distributionY,
            to: deployment.deployer,
            refundTo: deployment.deployer,
            deadline: block.timestamp + 1 hours
        });

        deployment.router.addLiquidity(liquidityParameters);
    }

    function _executeSmokeSwap(Deployment memory deployment) private returns (uint256 amountOut) {
        uint256[] memory pairBinSteps = new uint256[](1);
        ILBRouter.Version[] memory versions = new ILBRouter.Version[](1);
        IERC20[] memory tokenPath = new IERC20[](2);

        pairBinSteps[0] = DEFAULT_BIN_STEP;
        versions[0] = ILBRouter.Version.V2_2;
        tokenPath[0] = deployment.wnative;
        tokenPath[1] = deployment.usdc;

        ILBRouter.Path memory path =
            ILBRouter.Path({pairBinSteps: pairBinSteps, versions: versions, tokenPath: tokenPath});

        amountOut = deployment.router
            .swapExactTokensForTokens(SWAP_AMOUNT_IN, 0, path, deployment.deployer, block.timestamp + 1 hours);
    }

    function _manifestPath() private view returns (string memory) {
        string memory defaultPath = string.concat(vm.projectRoot(), "/deployments/localnet/latest.json");
        string memory configuredPath = vm.envOr("LOCALNET_MANIFEST_PATH", defaultPath);

        return bytes(configuredPath).length == 0 ? defaultPath : configuredPath;
    }

    function _writeManifest(string memory manifestPath, Deployment memory deployment) private {
        vm.createDir(string.concat(vm.projectRoot(), "/deployments/localnet"), true);

        _writeRoot(manifestPath, deployment);
        _writeContracts(manifestPath, deployment);
        _writeOwnership(manifestPath, deployment);
        _writeEndpoints(manifestPath);
        _writeTokens(manifestPath, deployment);
        _writePreset(manifestPath);
        _writePool(manifestPath, deployment);
        _writeConstructorArgs(manifestPath, deployment);
        _writeSmoke(manifestPath, deployment);
    }

    function _writeRoot(string memory manifestPath, Deployment memory deployment) private {
        string memory root = "localnet-root";
        vm.serializeString(root, "schemaVersion", "lb.localnet.v1");
        vm.serializeString(root, "environment", "localnet");
        vm.serializeString(root, "sourceJoeV2Commit", "067c6ccf5b8ff1526d03fa3e4c65ec45d01c1f73");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "startBlock", deployment.startBlock);
        string memory rootJson = vm.serializeAddress(root, "deployer", deployment.deployer);
        vm.writeJson(rootJson, manifestPath);
    }

    function _writeContracts(string memory manifestPath, Deployment memory deployment) private {
        string memory contractsObject = "localnet-contracts";
        vm.serializeAddress(contractsObject, "lbFactory", address(deployment.factory));
        vm.serializeAddress(contractsObject, "lbPairImplementation", address(deployment.pairImplementation));
        vm.serializeAddress(contractsObject, "lbRouter", address(deployment.router));
        string memory contractsJson = vm.serializeAddress(contractsObject, "lbQuoter", address(deployment.quoter));
        vm.writeJson(contractsJson, manifestPath, ".contracts");
    }

    function _writeOwnership(string memory manifestPath, Deployment memory deployment) private {
        string memory ownershipObject = "localnet-ownership";
        vm.serializeAddress(ownershipObject, "feeRecipient", deployment.deployer);
        vm.serializeAddress(ownershipObject, "initialOwner", deployment.deployer);
        string memory ownershipJson = vm.serializeAddress(ownershipObject, "lbFactoryOwner", deployment.deployer);
        vm.writeJson(ownershipJson, manifestPath, ".ownership");
    }

    function _writeEndpoints(string memory manifestPath) private {
        string memory endpointObject = "localnet-endpoints";
        vm.serializeString(endpointObject, "rpcUrl", vm.envOr("LOCALNET_RPC_URL", DEFAULT_LOCALNET_RPC_URL));
        vm.serializeString(endpointObject, "indexerUrl", vm.envOr("LOCALNET_INDEXER_URL", DEFAULT_LOCALNET_INDEXER_URL));
        string memory endpointJson =
            vm.serializeString(endpointObject, "apiUrl", vm.envOr("LOCALNET_API_URL", DEFAULT_LOCALNET_API_URL));
        string memory tokenListUrl = vm.envOr("LOCALNET_TOKEN_LIST_URL", string(""));
        if (bytes(tokenListUrl).length != 0) {
            endpointJson = vm.serializeString(endpointObject, "tokenListUrl", tokenListUrl);
        }
        vm.writeJson(endpointJson, manifestPath, ".endpoints");
    }

    function _writeTokens(string memory manifestPath, Deployment memory deployment) private {
        string memory tokensObject = "localnet-tokens";
        vm.serializeAddress(tokensObject, "wnative", address(deployment.wnative));
        vm.serializeAddress(tokensObject, "usdc", address(deployment.usdc));
        vm.serializeAddress(tokensObject, "usdt", address(deployment.usdt));
        string memory tokensJson = vm.serializeAddress(tokensObject, "weth", address(deployment.weth));
        vm.writeJson(tokensJson, manifestPath, ".tokens");
    }

    function _writePreset(string memory manifestPath) private {
        string memory presetObject = "localnet-preset";
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

    function _writePool(string memory manifestPath, Deployment memory deployment) private {
        string memory poolObject = "localnet-pool";
        vm.serializeAddress(poolObject, "pair", address(deployment.wnativeUsdcPair));
        vm.serializeAddress(poolObject, "tokenX", address(deployment.wnative));
        vm.serializeAddress(poolObject, "tokenY", address(deployment.usdc));
        vm.serializeUint(poolObject, "activeId", ID_ONE);
        string memory poolJson = vm.serializeUint(poolObject, "binStep", DEFAULT_BIN_STEP);
        vm.writeJson(poolJson, manifestPath, ".seededPools.wnativeUsdc");
    }

    function _writeConstructorArgs(string memory manifestPath, Deployment memory deployment) private {
        string memory constructorObject = "localnet-constructor-args";
        vm.serializeAddress(constructorObject, "feeRecipient", deployment.deployer);
        vm.serializeAddress(constructorObject, "initialOwner", deployment.deployer);
        vm.serializeUint(constructorObject, "flashLoanFee", FLASHLOAN_FEE);
        vm.serializeAddress(constructorObject, "routerFactoryV1", address(0));
        vm.serializeAddress(constructorObject, "routerLegacyFactoryV2", address(0));
        vm.serializeAddress(constructorObject, "routerLegacyRouterV2", address(0));
        vm.serializeAddress(constructorObject, "routerFactoryV2_1", address(0));
        string memory constructorJson =
            vm.serializeAddress(constructorObject, "routerWNative", address(deployment.wnative));
        vm.writeJson(constructorJson, manifestPath, ".constructorArgs");
    }

    function _writeSmoke(string memory manifestPath, Deployment memory deployment) private {
        string memory smokeObject = "localnet-smoke";
        vm.serializeAddress(smokeObject, "swapTokenIn", address(deployment.wnative));
        vm.serializeAddress(smokeObject, "swapTokenOut", address(deployment.usdc));
        vm.serializeUint(smokeObject, "liquidityAmountX", LIQUIDITY_AMOUNT_X);
        vm.serializeUint(smokeObject, "liquidityAmountY", LIQUIDITY_AMOUNT_Y);
        vm.serializeUint(smokeObject, "swapAmountIn", SWAP_AMOUNT_IN);
        string memory smokeJson = vm.serializeUint(smokeObject, "swapAmountOut", deployment.swapAmountOut);
        vm.writeJson(smokeJson, manifestPath, ".smoke");
    }
}
