// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "forge-std/Script.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LBFactory} from "src/LBFactory.sol";
import {ILBPair} from "src/interfaces/ILBPair.sol";
import {ILBRouter, LBRouter} from "src/LBRouter.sol";
import {ERC20Mock} from "test/mocks/ERC20.sol";

/// @notice Creates and funds a realistic local-only WETH/USDC curve across 31 bins.
/// @dev Re-running the script adds the same distribution again; it never fabricates indexer rows.
contract LocalnetLiquiditySeedScript is Script {
    uint256 private constant ANVIL_ACCOUNT_0_PRIVATE_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    uint24 private constant WETH_USDC_ACTIVE_ID = 8_396_213;
    uint16 private constant BIN_STEP = 10;
    int256 private constant CURVE_RADIUS = 15;
    uint256 private constant DISTRIBUTION_PRECISION = 1e18;
    uint256 private constant WETH_AMOUNT = 100 ether;
    uint256 private constant USDC_AMOUNT = 200_000 ether;
    string private constant DEFAULT_LOCALNET_MANIFEST_PATH = "/deployments/localnet/latest.json";

    function run() external returns (ILBPair pair) {
        uint256 deployerKey = vm.envOr("LOCALNET_PRIVATE_KEY", ANVIL_ACCOUNT_0_PRIVATE_KEY);
        address deployer = vm.addr(deployerKey);
        string memory manifestPath = _manifestPath();
        string memory manifest = vm.readFile(manifestPath);

        LBFactory factory = LBFactory(vm.parseJsonAddress(manifest, ".contracts.lbFactory"));
        LBRouter router = LBRouter(payable(vm.parseJsonAddress(manifest, ".contracts.lbRouter")));
        ERC20Mock weth = ERC20Mock(vm.parseJsonAddress(manifest, ".tokens.weth"));
        ERC20Mock usdc = ERC20Mock(vm.parseJsonAddress(manifest, ".tokens.usdc"));

        vm.startBroadcast(deployerKey);

        pair = factory.getLBPairInformation(weth, usdc, BIN_STEP).LBPair;
        if (address(pair) == address(0)) {
            pair = factory.createLBPair(weth, usdc, WETH_USDC_ACTIVE_ID, BIN_STEP);
        }

        if (address(pair.getTokenX()) != address(weth) || address(pair.getTokenY()) != address(usdc)) {
            revert("LOCALNET_WETH_USDC_ORDER");
        }

        weth.mint(deployer, WETH_AMOUNT);
        usdc.mint(deployer, USDC_AMOUNT);
        weth.approve(address(router), WETH_AMOUNT);
        usdc.approve(address(router), USDC_AMOUNT);

        (int256[] memory deltaIds, uint256[] memory distributionX, uint256[] memory distributionY) =
            _curveDistribution();
        uint24 activeId = pair.getActiveId();
        router.addLiquidity(
            ILBRouter.LiquidityParameters({
                tokenX: IERC20(address(weth)),
                tokenY: IERC20(address(usdc)),
                binStep: BIN_STEP,
                amountX: WETH_AMOUNT,
                amountY: USDC_AMOUNT,
                amountXMin: WETH_AMOUNT,
                amountYMin: USDC_AMOUNT,
                activeIdDesired: activeId,
                idSlippage: 0,
                deltaIds: deltaIds,
                distributionX: distributionX,
                distributionY: distributionY,
                to: deployer,
                refundTo: deployer,
                deadline: type(uint256).max
            })
        );

        vm.stopBroadcast();

        uint256 fundedBinCount = _fundedBinCount(pair, activeId);
        if (fundedBinCount != uint256(CURVE_RADIUS * 2 + 1)) revert("LOCALNET_CURVE_INCOMPLETE");

        _writePool(manifestPath, pair, activeId);

        console.log("WETH/USDC pair:", address(pair));
        console.log("WETH/USDC active bin:", activeId);
        console.log("Funded bins:", fundedBinCount);
    }

    function _curveDistribution()
        private
        pure
        returns (int256[] memory deltaIds, uint256[] memory distributionX, uint256[] memory distributionY)
    {
        uint256 count = uint256(CURVE_RADIUS * 2 + 1);
        deltaIds = new int256[](count);
        distributionX = new uint256[](count);
        distributionY = new uint256[](count);

        uint256 rawWeightTotal;
        for (int256 delta = 0; delta <= CURVE_RADIUS; delta++) {
            uint256 distanceWeight = uint256(CURVE_RADIUS + 1 - delta);
            rawWeightTotal += distanceWeight * distanceWeight;
        }

        uint256 distributedX;
        uint256 distributedY;
        for (int256 delta = -CURVE_RADIUS; delta <= CURVE_RADIUS; delta++) {
            uint256 index = uint256(delta + CURVE_RADIUS);
            deltaIds[index] = delta;
            uint256 distance = uint256(delta < 0 ? -delta : delta);
            uint256 distanceWeight = uint256(CURVE_RADIUS + 1) - distance;
            uint256 weight = (DISTRIBUTION_PRECISION * distanceWeight * distanceWeight) / rawWeightTotal;

            if (delta >= 0) {
                distributionX[index] = weight;
                distributedX += weight;
            }
            if (delta <= 0) {
                distributionY[index] = weight;
                distributedY += weight;
            }
        }

        distributionX[distributionX.length - 1] += DISTRIBUTION_PRECISION - distributedX;
        distributionY[uint256(CURVE_RADIUS)] += DISTRIBUTION_PRECISION - distributedY;
    }

    function _fundedBinCount(ILBPair pair, uint24 activeId) private view returns (uint256 funded) {
        for (int256 delta = -CURVE_RADIUS; delta <= CURVE_RADIUS; delta++) {
            uint24 binId = uint24(uint256(int256(uint256(activeId)) + delta));
            (uint128 reserveX, uint128 reserveY) = pair.getBin(binId);
            if (reserveX != 0 || reserveY != 0) funded++;
        }
    }

    function _writePool(string memory manifestPath, ILBPair pair, uint24 activeId) private {
        string memory poolObject = "localnet-weth-usdc-pool";
        vm.serializeAddress(poolObject, "pair", address(pair));
        vm.serializeAddress(poolObject, "tokenX", address(pair.getTokenX()));
        vm.serializeAddress(poolObject, "tokenY", address(pair.getTokenY()));
        vm.serializeUint(poolObject, "activeId", activeId);
        string memory poolJson = vm.serializeUint(poolObject, "binStep", BIN_STEP);
        vm.writeJson(poolJson, manifestPath, ".seededPools.wethUsdc");
    }

    function _manifestPath() private view returns (string memory) {
        string memory defaultPath = string.concat(vm.projectRoot(), DEFAULT_LOCALNET_MANIFEST_PATH);
        string memory configuredPath = vm.envOr("LOCALNET_MANIFEST_PATH", defaultPath);
        return bytes(configuredPath).length == 0 ? defaultPath : configuredPath;
    }
}
