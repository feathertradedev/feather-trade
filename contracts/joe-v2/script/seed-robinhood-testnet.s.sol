// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "forge-std/Script.sol";

import {IERC20} from "src/LBPair.sol";
import {ILBFactory} from "src/interfaces/ILBFactory.sol";
import {ILBPair} from "src/interfaces/ILBPair.sol";
import {ILBRouter, LBRouter} from "src/LBRouter.sol";
import {IWNATIVE} from "src/interfaces/IWNATIVE.sol";

import {ERC20Mock} from "test/mocks/ERC20.sol";

contract RobinhoodTestnetSeedScript is Script {
    uint24 private constant ID_ONE = 8_388_608;
    uint16 private constant DEFAULT_BIN_STEP = 10;
    uint256 private constant DISTRIBUTION_PRECISION = 1e18;
    uint256 private constant TOKEN_MINT_AMOUNT = 1 ether;
    uint256 private constant TOKEN_LIQUIDITY_AMOUNT = 0.0002 ether;
    uint256 private constant WNATIVE_LIQUIDITY_AMOUNT = 0.0002 ether;
    uint256 private constant SWAP_AMOUNT_IN = 0.00001 ether;

    struct SeedResult {
        address deployer;
        ERC20Mock mockToken;
        ILBPair pair;
        uint256 swapAmountOut;
        uint256 removedAmountX;
        uint256 removedAmountY;
    }

    function run() external returns (SeedResult memory result) {
        uint256 deployerKey = vm.envUint("ROBINHOOD_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        ILBFactory factory = ILBFactory(vm.envAddress("ROBINHOOD_LB_FACTORY"));
        LBRouter router = LBRouter(payable(vm.envAddress("ROBINHOOD_LB_ROUTER")));
        IWNATIVE wrappedNative = IWNATIVE(vm.envAddress("ROBINHOOD_WNATIVE"));

        vm.startBroadcast(deployerKey);

        ERC20Mock mockToken = new ERC20Mock(18);
        mockToken.mint(deployer, TOKEN_MINT_AMOUNT);
        wrappedNative.deposit{value: WNATIVE_LIQUIDITY_AMOUNT}();

        _approveRouterIfNeeded(mockToken, router, TOKEN_LIQUIDITY_AMOUNT + SWAP_AMOUNT_IN, deployer);
        _approveRouterIfNeeded(wrappedNative, router, WNATIVE_LIQUIDITY_AMOUNT, deployer);

        ILBPair pair = ILBPair(address(router.createLBPair(mockToken, wrappedNative, ID_ONE, DEFAULT_BIN_STEP)));
        _addLiquidity(router, mockToken, wrappedNative, deployer);
        uint256 swapAmountOut = _swap(router, mockToken, wrappedNative, deployer);
        (uint256 removedAmountX, uint256 removedAmountY) =
            _removeHalfLiquidity(router, pair, mockToken, wrappedNative, deployer);

        vm.stopBroadcast();

        if (address(pair).code.length == 0) revert("ROBINHOOD_SEED_PAIR_NOT_DEPLOYED");
        if (swapAmountOut == 0) revert("ROBINHOOD_SEED_SWAP_ZERO_OUT");

        result = SeedResult({
            deployer: deployer,
            mockToken: mockToken,
            pair: pair,
            swapAmountOut: swapAmountOut,
            removedAmountX: removedAmountX,
            removedAmountY: removedAmountY
        });

        console.log("Robinhood seed mock token:", address(mockToken));
        console.log("Robinhood seed pair:", address(pair));
        console.log("Robinhood seed swap amount out:", swapAmountOut);
        console.log("Robinhood seed removed token X:", removedAmountX);
        console.log("Robinhood seed removed token Y:", removedAmountY);

        // Touch factory so the script fails early if the env address is not an LBFactory.
        factory.getNumberOfLBPairs();
    }

    function _addLiquidity(LBRouter router, ERC20Mock mockToken, IWNATIVE wrappedNative, address deployer) private {
        int256[] memory deltaIds = new int256[](1);
        uint256[] memory distributionX = new uint256[](1);
        uint256[] memory distributionY = new uint256[](1);

        distributionX[0] = DISTRIBUTION_PRECISION;
        distributionY[0] = DISTRIBUTION_PRECISION;

        ILBRouter.LiquidityParameters memory liquidityParameters = ILBRouter.LiquidityParameters({
            tokenX: mockToken,
            tokenY: wrappedNative,
            binStep: DEFAULT_BIN_STEP,
            amountX: TOKEN_LIQUIDITY_AMOUNT,
            amountY: WNATIVE_LIQUIDITY_AMOUNT,
            amountXMin: 0,
            amountYMin: 0,
            activeIdDesired: ID_ONE,
            idSlippage: 0,
            deltaIds: deltaIds,
            distributionX: distributionX,
            distributionY: distributionY,
            to: deployer,
            refundTo: deployer,
            deadline: block.timestamp + 1 hours
        });

        router.addLiquidity(liquidityParameters);
    }

    function _approveRouterIfNeeded(IERC20 token, LBRouter router, uint256 requiredAmount, address deployer) private {
        if (token.allowance(deployer, address(router)) >= requiredAmount) return;

        token.approve(address(router), 0);
        token.approve(address(router), type(uint256).max);
    }

    function _swap(LBRouter router, ERC20Mock mockToken, IWNATIVE wrappedNative, address deployer)
        private
        returns (uint256 amountOut)
    {
        uint256[] memory pairBinSteps = new uint256[](1);
        ILBRouter.Version[] memory versions = new ILBRouter.Version[](1);
        IERC20[] memory tokenPath = new IERC20[](2);

        pairBinSteps[0] = DEFAULT_BIN_STEP;
        versions[0] = ILBRouter.Version.V2_2;
        tokenPath[0] = mockToken;
        tokenPath[1] = wrappedNative;

        ILBRouter.Path memory path =
            ILBRouter.Path({pairBinSteps: pairBinSteps, versions: versions, tokenPath: tokenPath});

        amountOut = router.swapExactTokensForTokens(SWAP_AMOUNT_IN, 0, path, deployer, block.timestamp + 1 hours);
    }

    function _removeHalfLiquidity(
        LBRouter router,
        ILBPair pair,
        ERC20Mock mockToken,
        IWNATIVE wrappedNative,
        address deployer
    ) private returns (uint256 amountX, uint256 amountY) {
        uint256 liquidity = pair.balanceOf(deployer, ID_ONE);
        if (liquidity < 2) revert("ROBINHOOD_SEED_NO_LIQUIDITY");

        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);

        ids[0] = ID_ONE;
        amounts[0] = liquidity / 2;

        pair.approveForAll(address(router), true);

        (amountX, amountY) = router.removeLiquidity(
            mockToken, wrappedNative, DEFAULT_BIN_STEP, 0, 0, ids, amounts, deployer, block.timestamp + 1 hours
        );

        if (amountX == 0 && amountY == 0) revert("ROBINHOOD_SEED_REMOVE_ZERO_OUT");
    }
}
