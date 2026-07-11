// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "forge-std/Script.sol";

import {IERC20} from "src/LBPair.sol";
import {ILBFactory} from "src/interfaces/ILBFactory.sol";
import {ILBPair} from "src/interfaces/ILBPair.sol";
import {ILBRouter, LBRouter} from "src/LBRouter.sol";
import {IWNATIVE} from "src/interfaces/IWNATIVE.sol";

import {ERC20Mock} from "test/mocks/ERC20.sol";

contract RobinhoodMultibinRemoveRehearsalScript is Script {
    uint256 private constant ROBINHOOD_MAINNET_CHAIN_ID = 4_663;
    uint256 private constant ROBINHOOD_TESTNET_CHAIN_ID = 46_630;
    uint256 private constant PLACEHOLDER_PRIVATE_KEY =
        0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    uint24 private constant ID_ONE = 8_388_608;
    uint16 private constant DEFAULT_BIN_STEP = 10;
    uint256 private constant DISTRIBUTION_PRECISION = 1e18;
    uint256 private constant BIN_COUNT = 7;
    uint256 private constant SPREAD = 3;
    uint256 private constant TOKEN_MINT_AMOUNT = 2 ether;
    uint256 private constant TOKEN_LIQUIDITY_AMOUNT = 0.0007 ether;
    uint256 private constant WNATIVE_LIQUIDITY_AMOUNT = 0.0007 ether;

    struct RehearsalContext {
        address deployer;
        ILBFactory factory;
        LBRouter router;
        IWNATIVE wrappedNative;
        ERC20Mock testToken;
        ILBPair pair;
        uint256[] ids;
        uint256[] liquidityMinted;
        uint256[] balances;
        uint256[] burnAmounts;
        uint256 removedAmountX;
        uint256 removedAmountY;
    }

    function run() external {
        _assertRobinhoodChainId();

        uint256 deployerKey = _deployerKey();
        RehearsalContext memory ctx;

        ctx.deployer = vm.addr(deployerKey);
        ctx.factory = ILBFactory(vm.envAddress("ROBINHOOD_LB_FACTORY"));
        ctx.router = LBRouter(payable(vm.envAddress("ROBINHOOD_LB_ROUTER")));
        ctx.wrappedNative = IWNATIVE(vm.envAddress("ROBINHOOD_WNATIVE"));

        _assertHasCode("ROBINHOOD_LB_FACTORY", address(ctx.factory));
        _assertHasCode("ROBINHOOD_LB_ROUTER", address(ctx.router));
        _assertHasCode("ROBINHOOD_WNATIVE", address(ctx.wrappedNative));
        if (address(ctx.router.getFactory()) != address(ctx.factory)) {
            revert("ROBINHOOD_MULTIBIN_ROUTER_FACTORY_MISMATCH");
        }
        if (address(ctx.router.getWNATIVE()) != address(ctx.wrappedNative)) {
            revert("ROBINHOOD_MULTIBIN_ROUTER_WNATIVE_MISMATCH");
        }

        // Touch factory before broadcasting so an invalid env address fails without sending transactions.
        ctx.factory.getNumberOfLBPairs();

        vm.startBroadcast(deployerKey);

        ctx.testToken = new ERC20Mock(18);
        ctx.testToken.mint(ctx.deployer, TOKEN_MINT_AMOUNT);
        ctx.wrappedNative.deposit{value: WNATIVE_LIQUIDITY_AMOUNT}();

        _approveRouterIfNeeded(ctx.testToken, ctx.router, TOKEN_LIQUIDITY_AMOUNT, ctx.deployer);
        _approveRouterIfNeeded(ctx.wrappedNative, ctx.router, WNATIVE_LIQUIDITY_AMOUNT, ctx.deployer);

        ctx.pair = ILBPair(address(ctx.router.createLBPair(ctx.testToken, ctx.wrappedNative, ID_ONE, DEFAULT_BIN_STEP)));
        (ctx.ids, ctx.liquidityMinted) = _addLiquidity(ctx.router, ctx.testToken, ctx.wrappedNative, ctx.deployer);
        ctx.balances = _readBalances(ctx.pair, ctx.deployer, ctx.ids);
        (ctx.burnAmounts, ctx.removedAmountX, ctx.removedAmountY) = _removeHalfLiquidity(ctx);

        vm.stopBroadcast();

        if (address(ctx.pair).code.length == 0) revert("ROBINHOOD_MULTIBIN_PAIR_NOT_DEPLOYED");
        if (ctx.removedAmountX == 0 || ctx.removedAmountY == 0) revert("ROBINHOOD_MULTIBIN_REMOVE_ZERO_SIDE");

        _logResult(ctx);
    }

    function _removeHalfLiquidity(RehearsalContext memory ctx)
        private
        returns (uint256[] memory burnAmounts, uint256 amountX, uint256 amountY)
    {
        burnAmounts = _halfBalances(ctx.balances);
        ctx.pair.approveForAll(address(ctx.router), true);

        (amountX, amountY) = ctx.router
            .removeLiquidity(
                ctx.testToken,
                ctx.wrappedNative,
                DEFAULT_BIN_STEP,
                0,
                0,
                ctx.ids,
                burnAmounts,
                ctx.deployer,
                block.timestamp + 1 hours
            );
    }

    function _logResult(RehearsalContext memory ctx) private view {
        console.log("Robinhood multibin test token:", address(ctx.testToken));
        console.log("Robinhood multibin pair:", address(ctx.pair));
        console.log("Robinhood multibin bin count:", ctx.ids.length);
        console.log("Robinhood multibin removed token X:", ctx.removedAmountX);
        console.log("Robinhood multibin removed token Y:", ctx.removedAmountY);

        for (uint256 i; i < ctx.ids.length; ++i) {
            (uint128 reserveX, uint128 reserveY) = ctx.pair.getBin(uint24(ctx.ids[i]));
            console.log("Robinhood multibin id:", ctx.ids[i]);
            console.log("Robinhood multibin pre-burn balance:", ctx.balances[i]);
            console.log("Robinhood multibin minted liquidity:", ctx.liquidityMinted[i]);
            console.log("Robinhood multibin burn amount:", ctx.burnAmounts[i]);
            console.log("Robinhood multibin post-burn balance:", ctx.pair.balanceOf(ctx.deployer, ctx.ids[i]));
            console.log("Robinhood multibin bin reserve X:", reserveX);
            console.log("Robinhood multibin bin reserve Y:", reserveY);
            console.log("Robinhood multibin bin total supply:", ctx.pair.totalSupply(ctx.ids[i]));
        }
    }

    function _addLiquidity(LBRouter router, ERC20Mock testToken, IWNATIVE wrappedNative, address deployer)
        private
        returns (uint256[] memory depositIds, uint256[] memory liquidityMinted)
    {
        int256[] memory deltaIds = new int256[](BIN_COUNT);
        uint256[] memory distributionX = new uint256[](BIN_COUNT);
        uint256[] memory distributionY = new uint256[](BIN_COUNT);
        uint256 sideDistribution = DISTRIBUTION_PRECISION / (SPREAD + 1);

        for (uint256 i; i < BIN_COUNT; ++i) {
            int256 delta = _toInt256(i) - _toInt256(SPREAD);
            deltaIds[i] = delta;

            if (i <= SPREAD) distributionY[i] = sideDistribution;
            if (i >= SPREAD) distributionX[i] = sideDistribution;
        }

        ILBRouter.LiquidityParameters memory liquidityParameters = ILBRouter.LiquidityParameters({
            tokenX: testToken,
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

        (,,,, depositIds, liquidityMinted) = router.addLiquidity(liquidityParameters);
    }

    function _readBalances(ILBPair pair, address owner, uint256[] memory ids)
        private
        view
        returns (uint256[] memory balances)
    {
        balances = new uint256[](ids.length);

        for (uint256 i; i < ids.length; ++i) {
            balances[i] = pair.balanceOf(owner, ids[i]);
            if (balances[i] == 0) revert("ROBINHOOD_MULTIBIN_ZERO_BALANCE");
        }
    }

    function _halfBalances(uint256[] memory balances) private pure returns (uint256[] memory burnAmounts) {
        burnAmounts = new uint256[](balances.length);

        for (uint256 i; i < balances.length; ++i) {
            burnAmounts[i] = balances[i] / 2;
            if (burnAmounts[i] == 0) revert("ROBINHOOD_MULTIBIN_ZERO_BURN");
        }
    }

    function _approveRouterIfNeeded(IERC20 token, LBRouter router, uint256 requiredAmount, address deployer) private {
        if (token.allowance(deployer, address(router)) >= requiredAmount) return;

        token.approve(address(router), 0);
        token.approve(address(router), type(uint256).max);
    }

    function _deployerKey() private view returns (uint256 deployerKey) {
        deployerKey = vm.envOr("ROBINHOOD_DEPLOYER_PRIVATE_KEY", uint256(0));
        if (deployerKey == 0) deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));

        if (deployerKey == 0 || deployerKey == PLACEHOLDER_PRIVATE_KEY) {
            revert("ROBINHOOD_MULTIBIN_PRIVATE_KEY_REQUIRED");
        }
    }

    function _assertRobinhoodChainId() private view {
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) revert("ROBINHOOD_MULTIBIN_MAINNET_DISABLED");

        uint256 expectedChainId = _expectedChainId();
        if (block.chainid != expectedChainId) {
            revert(
                string.concat(
                    "ROBINHOOD_MULTIBIN_WRONG_CHAIN_ID expected=",
                    vm.toString(expectedChainId),
                    " actual=",
                    vm.toString(block.chainid)
                )
            );
        }
    }

    function _expectedChainId() private view returns (uint256) {
        return vm.envOr("ROBINHOOD_EXPECTED_CHAIN_ID", ROBINHOOD_TESTNET_CHAIN_ID);
    }

    function _assertHasCode(string memory label, address target) private view {
        if (target.code.length == 0) revert(string.concat(label, "_CODE_MISSING"));
    }

    function _toInt256(uint256 value) private pure returns (int256) {
        if (value > uint256(type(int256).max)) revert("ROBINHOOD_MULTIBIN_INT_OVERFLOW");
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(value);
    }
}
