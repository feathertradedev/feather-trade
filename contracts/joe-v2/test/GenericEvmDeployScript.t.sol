// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {GenericEvmDeployScript} from "../script/deploy-evm.s.sol";
import {WNATIVE} from "test/mocks/WNATIVE.sol";

contract GenericEvmDeployScriptTest is Test {
    using stdJson for string;

    uint256 private constant DEPLOYER_KEY = 0xA11CE;
    string private constant SOURCE_COMMIT = "067c6ccf5b8ff1526d03fa3e4c65ec45d01c1f73";

    GenericEvmDeployScript private _script;
    WNATIVE private _wrappedNative;
    string private _manifestPath;

    function setUp() public {
        _script = new GenericEvmDeployScript();
        _wrappedNative = new WNATIVE();
        _manifestPath = string.concat(vm.projectRoot(), "/deployments/evm-script-solidity-test.json");

        vm.setEnv("EVM_DEPLOY_EXPECTED_CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("EVM_DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_KEY));
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0");
        vm.setEnv("EVM_DEPLOY_NETWORK", "solidity-test");
        vm.setEnv("EVM_DEPLOY_WNATIVE_ADDRESS", vm.toString(address(_wrappedNative)));
        vm.setEnv("EVM_DEPLOY_QUOTE_ASSET_0", vm.toString(address(0)));
        vm.setEnv("EVM_DEPLOY_QUOTE_ASSET_1", vm.toString(address(0)));
        vm.setEnv("EVM_DEPLOY_QUOTE_ASSET_2", vm.toString(address(0)));
        vm.setEnv("EVM_DEPLOY_QUOTE_ASSET_3", vm.toString(address(0)));
        vm.setEnv("EVM_DEPLOY_CHAIN_NAME", "Solidity Test Chain");
        vm.setEnv("EVM_DEPLOY_NATIVE_CURRENCY", "ETH");
        vm.setEnv("EVM_DEPLOY_RPC_ENV_VAR", "TEST_RPC_URL");
        vm.setEnv("EVM_DEPLOY_EXPLORER_URL", "");
        vm.setEnv("EVM_DEPLOY_VERIFIER_URL", "");
        vm.setEnv("EVM_DEPLOY_SOURCE_COMMIT", SOURCE_COMMIT);
        vm.setEnv("EVM_DEPLOY_SOURCE_TREE_DIRTY", "false");
        vm.setEnv("EVM_DEPLOY_MANIFEST_PATH", _manifestPath);
    }

    function test_RunDeploysAndCapturesCoreAndRejectsUnsafeInputs() public {
        GenericEvmDeployScript.Deployment memory deployment = _script.run();
        address deployer = vm.addr(DEPLOYER_KEY);

        assertEq(deployment.deployer, deployer);
        assertEq(address(deployment.wrappedNative), address(_wrappedNative));
        assertGt(address(deployment.factory).code.length, 0);
        assertGt(address(deployment.pairImplementation).code.length, 0);
        assertGt(address(deployment.router).code.length, 0);
        assertGt(address(deployment.quoter).code.length, 0);
        assertEq(deployment.factory.owner(), deployer);
        assertEq(deployment.factory.pendingOwner(), address(0));
        assertEq(deployment.factory.getFeeRecipient(), deployer);
        assertEq(deployment.factory.getNumberOfQuoteAssets(), 1);
        assertTrue(deployment.factory.isQuoteAsset(_wrappedNative));

        string memory manifest = vm.readFile(_manifestPath);
        assertEq(manifest.readString(".schemaVersion"), "lb.evm.v1");
        assertEq(manifest.readString(".environment"), "solidity-test");
        assertEq(manifest.readUint(".chainId"), block.chainid);
        assertEq(manifest.readAddress(".deployer"), deployer);
        assertEq(manifest.readAddress(".contracts.lbFactory"), address(deployment.factory));
        assertEq(manifest.readAddress(".contracts.lbPairImplementation"), address(deployment.pairImplementation));
        assertEq(manifest.readAddress(".contracts.lbRouter"), address(deployment.router));
        assertEq(manifest.readAddress(".contracts.lbQuoter"), address(deployment.quoter));
        assertEq(manifest.readAddress(".tokens.wrappedNative"), address(_wrappedNative));
        assertEq(manifest.readString(".sourceCommit"), SOURCE_COMMIT);
        assertFalse(manifest.readBool(".sourceTreeDirty"));
        vm.removeFile(_manifestPath);

        vm.setEnv("EVM_DEPLOY_EXPECTED_CHAIN_ID", "1");
        vm.expectRevert(
            bytes(string.concat("EVM_DEPLOY_WRONG_CHAIN_ID expected=1 actual=", vm.toString(block.chainid)))
        );
        _script.run();

        vm.setEnv("EVM_DEPLOY_EXPECTED_CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("EVM_DEPLOYER_PRIVATE_KEY", vm.toString(type(uint256).max));
        vm.expectRevert("EVM_DEPLOY_PRIVATE_KEY_REQUIRED");
        _script.run();

        vm.setEnv("EVM_DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_KEY));
        vm.setEnv("EVM_DEPLOY_QUOTE_ASSET_0", vm.toString(address(0xBEEF)));
        vm.expectRevert("EVM_DEPLOY_QUOTE_ASSET_NOT_DEPLOYED");
        _script.run();
    }
}
