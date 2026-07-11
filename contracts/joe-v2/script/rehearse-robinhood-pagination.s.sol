// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IERC20} from "src/LBPair.sol";
import {ILBFactory} from "src/interfaces/ILBFactory.sol";
import {ILBPair} from "src/interfaces/ILBPair.sol";
import {ILBRouter, LBRouter} from "src/LBRouter.sol";
import {IWNATIVE} from "src/interfaces/IWNATIVE.sol";
import {Uint256x256Math} from "src/libraries/math/Uint256x256Math.sol";

import {ERC20Mock} from "test/mocks/ERC20.sol";

contract RobinhoodPaginationRehearsalScript is Script {
    using Uint256x256Math for uint256;

    uint256 private constant ROBINHOOD_MAINNET_CHAIN_ID = 4_663;
    uint256 private constant ROBINHOOD_TESTNET_CHAIN_ID = 46_630;
    address private constant ROBINHOOD_TESTNET_CANONICAL_LB_ROUTER = 0x502E6516887547130A0E7cFd3f9849c57651d479;
    uint256 private constant PLACEHOLDER_PRIVATE_KEY =
        0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    uint256 private constant BASIS_POINT_MAX = 10_000;
    uint256 private constant MINIMUM_ALLOWED_FILL_BPS = 9_500;
    uint256 private constant MAXIMUM_ALLOWED_FILL_BPS = 9_999;
    uint256 private constant DEFAULT_MINIMUM_FILL_BPS = 9_950;
    uint256 private constant DEFAULT_NATIVE_GAS_RESERVE = 10_000_000_000_000;
    uint256 private constant PINNED_DRY_RUN_FULL_MODE_GAS_UNITS = 11_148_731;
    uint256 private constant PINNED_DRY_RUN_ADD_LIQUIDITY_GAS_UNITS = 10_741_386;
    uint256 private constant MINIMUM_FULL_MODE_GAS_UNITS = 15_000_000;
    // Two standalone approval(0) recovery transactions, with 100,000 gas units each.
    uint256 private constant RECOVERY_GAS_UNITS = 200_000;
    uint256 private constant DEFAULT_MAX_GAS_PRICE_WEI = 10_000_000;
    uint256 private constant DISTRIBUTION_PRECISION = 1e18;
    uint256 private constant BIN_COUNT = 101;
    uint256 private constant CENTER_INDEX = BIN_COUNT / 2;
    uint256 private constant DEFAULT_TOKEN_LIQUIDITY_AMOUNT = 0.0101 ether;
    uint256 private constant DEFAULT_WNATIVE_LIQUIDITY_AMOUNT = 0.0101 ether;

    struct RehearsalContext {
        address deployer;
        ILBFactory factory;
        LBRouter router;
        IWNATIVE wrappedNative;
        ERC20Mock testToken;
        ILBPair pair;
        IERC20 tokenX;
        IERC20 tokenY;
        uint16 binStep;
        uint24 activeId;
        bool revokeOnly;
        uint256 minimumFillBps;
        uint256 nativeGasReserve;
        uint256 totalFullModeGasUnits;
        uint256 maxGasPriceWei;
        uint256 fullModeGasBudget;
        uint256 recoveryGasBudget;
        uint256 tokenLiquidityAmount;
        uint256 wrappedNativeLiquidityAmount;
        uint256 amountXMin;
        uint256 amountYMin;
        uint256 amountXAdded;
        uint256 amountYAdded;
        uint256[] depositIds;
        uint256[] liquidityMinted;
    }

    /**
     * Forge broadcasts each mint, wrap, approval, add, and revoke call as a separate transaction.
     * Earlier transactions remain mined if a later one fails. Set ROBINHOOD_PAGINATION_REVOKE_ONLY
     * to true to submit only the two approval revocations after a partial failure.
     */
    function run() external {
        _assertRobinhoodChainId();

        uint256 deployerKey = _deployerKey();
        RehearsalContext memory ctx;

        ctx.deployer = vm.addr(deployerKey);
        ctx.router = LBRouter(payable(vm.envAddress("ROBINHOOD_LB_ROUTER")));
        ctx.wrappedNative = IWNATIVE(vm.envAddress("ROBINHOOD_WNATIVE"));
        ctx.testToken = ERC20Mock(vm.envAddress("ROBINHOOD_PAGINATION_TOKEN"));
        ctx.revokeOnly = vm.envOr("ROBINHOOD_PAGINATION_REVOKE_ONLY", false);
        _configureRecoveryGasBudget(ctx);
        _assertGasPriceWithinCap(ctx);

        if (ctx.revokeOnly) {
            _assertRecoveryContext(ctx);
            _assertRevokeOnlyNativeBalance(ctx);
            _logMultiTransactionBehavior(ctx);

            vm.startBroadcast(deployerKey);
            _revokeRouterApprovals(ctx);
            vm.stopBroadcast();

            _assertRouterApprovalsRevoked(ctx);
            _logRecoveryResult(ctx);
            return;
        }

        ctx.factory = ILBFactory(vm.envAddress("ROBINHOOD_LB_FACTORY"));
        ctx.pair = ILBPair(vm.envAddress("ROBINHOOD_PAGINATION_PAIR"));
        ctx.nativeGasReserve = vm.envOr("ROBINHOOD_PAGINATION_NATIVE_GAS_RESERVE", DEFAULT_NATIVE_GAS_RESERVE);
        _configureFullModeGasBudget(ctx);

        _assertFullModePreBroadcastContext(ctx);
        _logMultiTransactionBehavior(ctx);

        ctx.binStep = _paginationBinStep();
        ctx.minimumFillBps = _minimumFillBps();
        ctx.tokenLiquidityAmount = vm.envOr("ROBINHOOD_PAGINATION_TOKEN_AMOUNT", DEFAULT_TOKEN_LIQUIDITY_AMOUNT);
        ctx.wrappedNativeLiquidityAmount =
            vm.envOr("ROBINHOOD_PAGINATION_WNATIVE_AMOUNT", DEFAULT_WNATIVE_LIQUIDITY_AMOUNT);

        ctx.tokenX = ctx.pair.getTokenX();
        ctx.tokenY = ctx.pair.getTokenY();
        ctx.activeId = ctx.pair.getActiveId();

        _assertPairConsistency(ctx);
        _setLiquidityMinimums(ctx);
        _assertLiquidityInputs(ctx);

        vm.startBroadcast(deployerKey);

        ctx.testToken.mint(ctx.deployer, ctx.tokenLiquidityAmount);
        ctx.wrappedNative.deposit{value: ctx.wrappedNativeLiquidityAmount}();

        _setExactRouterApproval(ctx.testToken, ctx.router, ctx.tokenLiquidityAmount, ctx.deployer);
        _setExactRouterApproval(ctx.wrappedNative, ctx.router, ctx.wrappedNativeLiquidityAmount, ctx.deployer);

        (ctx.amountXAdded, ctx.amountYAdded, ctx.depositIds, ctx.liquidityMinted) = _addLiquidity(ctx);
        _revokeRouterApprovals(ctx);

        vm.stopBroadcast();

        _assertRouterApprovalsRevoked(ctx);
        uint256 totalLiquidityMinted = _assertPaginationPositions(ctx);
        _logResult(ctx, totalLiquidityMinted);
    }

    function _addLiquidity(RehearsalContext memory ctx)
        private
        returns (
            uint256 amountXAdded,
            uint256 amountYAdded,
            uint256[] memory depositIds,
            uint256[] memory liquidityMinted
        )
    {
        int256[] memory deltaIds = new int256[](BIN_COUNT);
        uint256[] memory distributionX = new uint256[](BIN_COUNT);
        uint256[] memory distributionY = new uint256[](BIN_COUNT);
        uint256 sideDistribution = DISTRIBUTION_PRECISION / (CENTER_INDEX + 1);

        for (uint256 i; i < BIN_COUNT; ++i) {
            deltaIds[i] = _toInt256(i) - _toInt256(CENTER_INDEX);

            if (i <= CENTER_INDEX) distributionY[i] = sideDistribution;
            if (i >= CENTER_INDEX) distributionX[i] = sideDistribution;
        }

        bool testTokenIsX = address(ctx.tokenX) == address(ctx.testToken);
        uint256 amountX = testTokenIsX ? ctx.tokenLiquidityAmount : ctx.wrappedNativeLiquidityAmount;
        uint256 amountY = testTokenIsX ? ctx.wrappedNativeLiquidityAmount : ctx.tokenLiquidityAmount;

        ILBRouter.LiquidityParameters memory liquidityParameters = ILBRouter.LiquidityParameters({
            tokenX: ctx.tokenX,
            tokenY: ctx.tokenY,
            binStep: ctx.binStep,
            amountX: amountX,
            amountY: amountY,
            amountXMin: ctx.amountXMin,
            amountYMin: ctx.amountYMin,
            activeIdDesired: ctx.activeId,
            idSlippage: 0,
            deltaIds: deltaIds,
            distributionX: distributionX,
            distributionY: distributionY,
            to: ctx.deployer,
            refundTo: ctx.deployer,
            deadline: block.timestamp + 1 hours
        });

        (amountXAdded, amountYAdded,,, depositIds, liquidityMinted) = ctx.router.addLiquidity(liquidityParameters);
    }

    function _assertRecoveryContext(RehearsalContext memory ctx) private view {
        _assertHasCode("ROBINHOOD_LB_ROUTER", address(ctx.router));
        _assertHasCode("ROBINHOOD_WNATIVE", address(ctx.wrappedNative));
        _assertHasCode("ROBINHOOD_PAGINATION_TOKEN", address(ctx.testToken));

        if (address(ctx.router) != ROBINHOOD_TESTNET_CANONICAL_LB_ROUTER) {
            revert("ROBINHOOD_PAGINATION_NON_CANONICAL_ROUTER");
        }
        if (address(ctx.router.getWNATIVE()) != address(ctx.wrappedNative)) {
            revert("ROBINHOOD_PAGINATION_ROUTER_WNATIVE_MISMATCH");
        }
        if (address(ctx.testToken) == address(ctx.wrappedNative)) {
            revert("ROBINHOOD_PAGINATION_TOKEN_IS_WNATIVE");
        }
    }

    function _assertFullModePreBroadcastContext(RehearsalContext memory ctx) private view {
        _assertRecoveryContext(ctx);
        _assertHasCode("ROBINHOOD_LB_FACTORY", address(ctx.factory));
        _assertHasCode("ROBINHOOD_PAGINATION_PAIR", address(ctx.pair));

        if (address(ctx.router.getFactory()) != address(ctx.factory)) {
            revert("ROBINHOOD_PAGINATION_ROUTER_FACTORY_MISMATCH");
        }

        // Touch the factory before broadcasting so an incompatible contract fails without sending transactions.
        ctx.factory.getNumberOfLBPairs();
    }

    function _assertPairConsistency(RehearsalContext memory ctx) private view {
        if (address(ctx.pair.getFactory()) != address(ctx.factory)) {
            revert("ROBINHOOD_PAGINATION_PAIR_FACTORY_MISMATCH");
        }
        if (ctx.pair.getBinStep() != ctx.binStep) revert("ROBINHOOD_PAGINATION_PAIR_BIN_STEP_MISMATCH");

        bool tokenOrderMatches =
            address(ctx.tokenX) == address(ctx.testToken) && address(ctx.tokenY) == address(ctx.wrappedNative);
        bool reverseTokenOrderMatches =
            address(ctx.tokenX) == address(ctx.wrappedNative) && address(ctx.tokenY) == address(ctx.testToken);
        if (!tokenOrderMatches && !reverseTokenOrderMatches) {
            revert("ROBINHOOD_PAGINATION_PAIR_TOKEN_MISMATCH");
        }

        ILBFactory.LBPairInformation memory pairInformation =
            ctx.factory.getLBPairInformation(ctx.tokenX, ctx.tokenY, ctx.binStep);
        if (address(pairInformation.LBPair) != address(ctx.pair)) {
            revert("ROBINHOOD_PAGINATION_FACTORY_PAIR_MISMATCH");
        }
        if (pairInformation.binStep != ctx.binStep) {
            revert("ROBINHOOD_PAGINATION_FACTORY_BIN_STEP_MISMATCH");
        }
    }

    function _assertLiquidityInputs(RehearsalContext memory ctx) private view {
        if (ctx.testToken.owner() != ctx.deployer) revert("ROBINHOOD_PAGINATION_TOKEN_OWNER_MISMATCH");
        if (ctx.tokenLiquidityAmount == 0) revert("ROBINHOOD_PAGINATION_TOKEN_AMOUNT_ZERO");
        if (ctx.wrappedNativeLiquidityAmount == 0) revert("ROBINHOOD_PAGINATION_WNATIVE_AMOUNT_ZERO");
        if (ctx.amountXMin == 0 || ctx.amountYMin == 0) revert("ROBINHOOD_PAGINATION_MIN_AMOUNT_ZERO");
        _assertMinimumFill(
            ctx.amountXMin,
            ctx.tokenX == ctx.testToken ? ctx.tokenLiquidityAmount : ctx.wrappedNativeLiquidityAmount,
            ctx.minimumFillBps
        );
        _assertMinimumFill(
            ctx.amountYMin,
            ctx.tokenX == ctx.testToken ? ctx.wrappedNativeLiquidityAmount : ctx.tokenLiquidityAmount,
            ctx.minimumFillBps
        );
        _assertFullModeNativeBalance(ctx, ctx.wrappedNativeLiquidityAmount);
        if (uint256(ctx.activeId) < CENTER_INDEX || uint256(ctx.activeId) + CENTER_INDEX > type(uint24).max) {
            revert("ROBINHOOD_PAGINATION_ACTIVE_ID_OUT_OF_RANGE");
        }
    }

    function _assertPaginationPositions(RehearsalContext memory ctx)
        private
        view
        returns (uint256 totalLiquidityMinted)
    {
        if (ctx.amountXAdded == 0 || ctx.amountYAdded == 0) {
            revert("ROBINHOOD_PAGINATION_ZERO_AMOUNT_ADDED");
        }
        if (ctx.depositIds.length < BIN_COUNT || ctx.liquidityMinted.length != ctx.depositIds.length) {
            revert("ROBINHOOD_PAGINATION_POSITION_COUNT_TOO_LOW");
        }

        for (uint256 i; i < ctx.depositIds.length; ++i) {
            if (i > 0 && ctx.depositIds[i] != ctx.depositIds[i - 1] + 1) {
                revert("ROBINHOOD_PAGINATION_IDS_NOT_ORDERED");
            }
            if (ctx.liquidityMinted[i] == 0) revert("ROBINHOOD_PAGINATION_ZERO_LIQUIDITY_MINTED");
            if (ctx.pair.balanceOf(ctx.deployer, ctx.depositIds[i]) < ctx.liquidityMinted[i]) {
                revert("ROBINHOOD_PAGINATION_POSITION_BALANCE_TOO_LOW");
            }

            totalLiquidityMinted += ctx.liquidityMinted[i];
        }
    }

    function _logResult(RehearsalContext memory ctx, uint256 totalLiquidityMinted) private view {
        console.log("Robinhood pagination owner:", ctx.deployer);
        console.log("Robinhood pagination test token:", address(ctx.testToken));
        console.log("Robinhood pagination pair:", address(ctx.pair));
        console.log("Robinhood pagination router:", address(ctx.router));
        console.log("Robinhood pagination bin step:", ctx.binStep);
        console.log("Robinhood pagination minimum fill bps:", ctx.minimumFillBps);
        console.log("Robinhood pagination position count:", ctx.depositIds.length);
        console.log("Robinhood pagination first bin:", ctx.depositIds[0]);
        console.log("Robinhood pagination last bin:", ctx.depositIds[ctx.depositIds.length - 1]);
        console.log("Robinhood pagination token X minimum:", ctx.amountXMin);
        console.log("Robinhood pagination token Y minimum:", ctx.amountYMin);
        console.log("Robinhood pagination token X added:", ctx.amountXAdded);
        console.log("Robinhood pagination token Y added:", ctx.amountYAdded);
        console.log("Robinhood pagination total liquidity minted:", totalLiquidityMinted);
        console.log("Robinhood pagination router approvals revoked");
    }

    function _setExactRouterApproval(IERC20 token, LBRouter router, uint256 requiredAmount, address deployer) private {
        address spender = address(router);
        uint256 currentAllowance = token.allowance(deployer, spender);

        if (currentAllowance != requiredAmount) {
            if (currentAllowance != 0) _approve(token, spender, 0);
            _approve(token, spender, requiredAmount);
        }

        if (token.allowance(deployer, spender) != requiredAmount) {
            revert("ROBINHOOD_PAGINATION_EXACT_APPROVAL_FAILED");
        }
    }

    function _revokeRouterApprovals(RehearsalContext memory ctx) private {
        _approve(ctx.testToken, address(ctx.router), 0);
        _approve(ctx.wrappedNative, address(ctx.router), 0);
    }

    function _approve(IERC20 token, address spender, uint256 amount) private {
        if (!token.approve(spender, amount)) revert("ROBINHOOD_PAGINATION_APPROVAL_FAILED");
    }

    function _assertRouterApprovalsRevoked(RehearsalContext memory ctx) private view {
        if (ctx.testToken.allowance(ctx.deployer, address(ctx.router)) != 0) {
            revert("ROBINHOOD_PAGINATION_TOKEN_APPROVAL_NOT_REVOKED");
        }
        if (ctx.wrappedNative.allowance(ctx.deployer, address(ctx.router)) != 0) {
            revert("ROBINHOOD_PAGINATION_WNATIVE_APPROVAL_NOT_REVOKED");
        }
    }

    function _setLiquidityMinimums(RehearsalContext memory ctx) private pure {
        bool testTokenIsX = address(ctx.tokenX) == address(ctx.testToken);
        uint256 amountX = testTokenIsX ? ctx.tokenLiquidityAmount : ctx.wrappedNativeLiquidityAmount;
        uint256 amountY = testTokenIsX ? ctx.wrappedNativeLiquidityAmount : ctx.tokenLiquidityAmount;

        ctx.amountXMin = amountX.mulDivRoundUp(ctx.minimumFillBps, BASIS_POINT_MAX);
        ctx.amountYMin = amountY.mulDivRoundUp(ctx.minimumFillBps, BASIS_POINT_MAX);
    }

    function _configureFullModeGasBudget(RehearsalContext memory ctx) private view {
        ctx.totalFullModeGasUnits = vm.envOr("ROBINHOOD_PAGINATION_FULL_MODE_GAS_UNITS", MINIMUM_FULL_MODE_GAS_UNITS);

        if (ctx.totalFullModeGasUnits < MINIMUM_FULL_MODE_GAS_UNITS) {
            revert("ROBINHOOD_PAGINATION_GAS_ASSUMPTIONS_INVALID");
        }

        ctx.fullModeGasBudget = _checkedMultiply(ctx.totalFullModeGasUnits, ctx.maxGasPriceWei);
    }

    function _configureRecoveryGasBudget(RehearsalContext memory ctx) private view {
        ctx.maxGasPriceWei = vm.envOr("ROBINHOOD_PAGINATION_MAX_GAS_PRICE_WEI", DEFAULT_MAX_GAS_PRICE_WEI);
        if (ctx.maxGasPriceWei != DEFAULT_MAX_GAS_PRICE_WEI) revert("ROBINHOOD_PAGINATION_GAS_ASSUMPTIONS_INVALID");

        ctx.recoveryGasBudget = _checkedMultiply(RECOVERY_GAS_UNITS, ctx.maxGasPriceWei);
    }

    function _assertGasPriceWithinCap(RehearsalContext memory ctx) private view {
        if (tx.gasprice > ctx.maxGasPriceWei || block.basefee > ctx.maxGasPriceWei) {
            revert("ROBINHOOD_PAGINATION_GAS_PRICE_CAP_EXCEEDED");
        }
    }

    function _assertFullModeNativeBalance(RehearsalContext memory ctx, uint256 nativeAmountToWrap) private view {
        uint256 nativeBalance = ctx.deployer.balance;

        if (ctx.nativeGasReserve < DEFAULT_NATIVE_GAS_RESERVE) {
            revert("ROBINHOOD_PAGINATION_RECOVERY_GAS_RESERVE_INSUFFICIENT");
        }
        if (nativeAmountToWrap > nativeBalance) {
            revert("ROBINHOOD_PAGINATION_INSUFFICIENT_NATIVE_GAS_RESERVE");
        }

        uint256 nativeBalanceAfterWrap = nativeBalance - nativeAmountToWrap;
        uint256 requiredNativeBalanceAfterWrap = _checkedAdd(ctx.fullModeGasBudget, ctx.nativeGasReserve);
        if (requiredNativeBalanceAfterWrap > nativeBalanceAfterWrap) {
            revert("ROBINHOOD_PAGINATION_INSUFFICIENT_NATIVE_GAS_RESERVE");
        }
    }

    function _assertRevokeOnlyNativeBalance(RehearsalContext memory ctx) private view {
        if (ctx.deployer.balance < ctx.recoveryGasBudget) {
            revert("ROBINHOOD_PAGINATION_RECOVERY_NATIVE_BALANCE_INSUFFICIENT");
        }
    }

    function _assertMinimumFill(uint256 amountMin, uint256 amount, uint256 minimumFillBps) private pure {
        if (amountMin.mulDivRoundDown(BASIS_POINT_MAX, amount) < minimumFillBps) {
            revert("ROBINHOOD_PAGINATION_MINIMUM_FILL_ROUNDING");
        }
    }

    /**
     * The script broadcasts each external call as its own transaction. A later failure cannot roll
     * back earlier mint, wrap, or approval transactions; rerun with REVOKE_ONLY=true to clear both
     * router allowances without minting, wrapping, or adding liquidity.
     */
    function _logMultiTransactionBehavior(RehearsalContext memory ctx) private view {
        if (ctx.revokeOnly) {
            console.log("Robinhood pagination mode: revoke-only approval recovery");
        } else {
            console.log("Robinhood pagination mode: full 101-bin rehearsal");
        }

        console.log("Robinhood pagination transactions are non-atomic");
        console.log("A later failure leaves earlier mined transactions in place");
        console.log("Recovery: ROBINHOOD_PAGINATION_REVOKE_ONLY=true");
        console.log("Robinhood pagination recovery gas units:", RECOVERY_GAS_UNITS);
        console.log("Robinhood pagination max gas price wei:", ctx.maxGasPriceWei);
        console.log("Robinhood pagination script gas price wei:", tx.gasprice);
        console.log("Robinhood pagination base fee wei:", block.basefee);
        console.log("Robinhood pagination recovery gas budget:", ctx.recoveryGasBudget);
        if (!ctx.revokeOnly) {
            console.log("Robinhood pagination native gas reserve:", ctx.nativeGasReserve);
            console.log("Robinhood pagination pinned dry-run total gas units:", PINNED_DRY_RUN_FULL_MODE_GAS_UNITS);
            console.log(
                "Robinhood pagination pinned dry-run 101-bin add gas limit:", PINNED_DRY_RUN_ADD_LIQUIDITY_GAS_UNITS
            );
            console.log("Robinhood pagination full-mode gas units budget:", ctx.totalFullModeGasUnits);
            console.log("Robinhood pagination full-mode gas budget:", ctx.fullModeGasBudget);
        }
        console.log(
            "Robinhood pagination test-token allowance before:",
            ctx.testToken.allowance(ctx.deployer, address(ctx.router))
        );
        console.log(
            "Robinhood pagination WNATIVE allowance before:",
            ctx.wrappedNative.allowance(ctx.deployer, address(ctx.router))
        );
    }

    function _logRecoveryResult(RehearsalContext memory ctx) private view {
        console.log("Robinhood pagination revoke-only recovery complete");
        console.log("Robinhood pagination router:", address(ctx.router));
        console.log(
            "Robinhood pagination test-token allowance after:",
            ctx.testToken.allowance(ctx.deployer, address(ctx.router))
        );
        console.log(
            "Robinhood pagination WNATIVE allowance after:",
            ctx.wrappedNative.allowance(ctx.deployer, address(ctx.router))
        );
    }

    function _deployerKey() private view returns (uint256 deployerKey) {
        deployerKey = vm.envOr("ROBINHOOD_DEPLOYER_PRIVATE_KEY", uint256(0));
        if (deployerKey == 0) deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));

        if (deployerKey == 0 || deployerKey == PLACEHOLDER_PRIVATE_KEY) {
            revert("ROBINHOOD_PAGINATION_PRIVATE_KEY_REQUIRED");
        }
    }

    function _assertRobinhoodChainId() private view {
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) revert("ROBINHOOD_PAGINATION_MAINNET_DISABLED");
        if (block.chainid != ROBINHOOD_TESTNET_CHAIN_ID) {
            revert(
                string.concat(
                    "ROBINHOOD_PAGINATION_WRONG_CHAIN_ID expected=",
                    vm.toString(ROBINHOOD_TESTNET_CHAIN_ID),
                    " actual=",
                    vm.toString(block.chainid)
                )
            );
        }
    }

    function _paginationBinStep() private view returns (uint16 binStep) {
        uint256 configuredBinStep = vm.envUint("ROBINHOOD_PAGINATION_BIN_STEP");
        if (configuredBinStep == 0 || configuredBinStep > type(uint16).max) {
            revert("ROBINHOOD_PAGINATION_BIN_STEP_INVALID");
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        binStep = uint16(configuredBinStep);
    }

    function _minimumFillBps() private view returns (uint256 minimumFillBps) {
        minimumFillBps = vm.envOr("ROBINHOOD_PAGINATION_MINIMUM_FILL_BPS", DEFAULT_MINIMUM_FILL_BPS);
        if (minimumFillBps < MINIMUM_ALLOWED_FILL_BPS || minimumFillBps > MAXIMUM_ALLOWED_FILL_BPS) {
            revert("ROBINHOOD_PAGINATION_MINIMUM_FILL_BPS_INVALID");
        }
    }

    function _assertHasCode(string memory label, address target) private view {
        if (target.code.length == 0) revert(string.concat(label, "_CODE_MISSING"));
    }

    function _toInt256(uint256 value) private pure returns (int256) {
        if (value > uint256(type(int256).max)) revert("ROBINHOOD_PAGINATION_INT_OVERFLOW");
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(value);
    }

    function _checkedMultiply(uint256 x, uint256 y) private pure returns (uint256 result) {
        if (x != 0 && y > type(uint256).max / x) revert("ROBINHOOD_PAGINATION_GAS_BUDGET_OVERFLOW");
        result = x * y;
    }

    function _checkedAdd(uint256 x, uint256 y) private pure returns (uint256 result) {
        if (y > type(uint256).max - x) revert("ROBINHOOD_PAGINATION_GAS_BUDGET_OVERFLOW");
        result = x + y;
    }
}
