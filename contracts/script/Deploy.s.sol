// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2, stdJson } from "forge-std/Script.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { DRIFTCore } from "../src/core/DRIFTCore.sol";
import { DRIFTToken } from "../src/token/DRIFTToken.sol";
import { DRIFTClientFactory } from "../src/client/DRIFTClientFactory.sol";
import { WeightedGovernanceClient } from "../src/templates/WeightedGovernance.sol";

contract DeployScript is Script {
    using stdJson for string;

    string private deploymentPath;
    string private constant JSON_KEY = "deployment";
    string private jsonOutput;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address admin = vm.addr(deployerPrivateKey);

        string memory root = vm.projectRoot();
        deploymentPath = string.concat(root, "/deployments/", vm.toString(block.chainid), ".json");

        address existingProxy = _loadExistingProxyAddress();

        vm.startBroadcast(deployerPrivateKey);

        if (existingProxy == address(0)) {
            _bootstrap(admin);
        } else {
            _upgrade(existingProxy, admin);
        }

        vm.stopBroadcast();

        vm.writeJson(jsonOutput, deploymentPath);
        console2.log("Deployment state written to:", deploymentPath);
    }

    // Bootstrap ===============================================================

    function _bootstrap(address admin) internal {
        console2.log("Initializing system bootstrap sequence on chain:", block.chainid);

        DRIFTCore coreImpl = new DRIFTCore();
        console2.log("Core implementation:", address(coreImpl));

        bytes memory coreInitData = abi.encodeWithSelector(DRIFTCore.initialize.selector, admin);
        ERC1967Proxy coreProxy = new ERC1967Proxy(address(coreImpl), coreInitData);
        DRIFTCore core = DRIFTCore(address(coreProxy));
        console2.log("Core proxy: ", address(core));

        DRIFTToken token = new DRIFTToken(address(core));
        console2.log("DRIFTToken: ", address(token));

        core.setDriftToken(address(token));

        DRIFTClientFactory factory = new DRIFTClientFactory(address(core));
        core.grantRole(core.FACTORY_ROLE(), address(factory));
        console2.log("Factory: ", address(factory));
        console2.log("FACTORY_ROLE granted to factory.");

        WeightedGovernanceClient wgTemplate = new WeightedGovernanceClient();
        console2.log("WG Template: ", address(wgTemplate));

        _serialize(address(core), address(coreImpl), address(token), address(factory), address(wgTemplate));

        console2.log("Bootstrap complete.");
    }

    // Upgrade ===============================================================

    function _upgrade(address proxyAddr, address admin) internal {
        console2.log("Existing system proxy detected at:", proxyAddr);
        console2.log("Initializing UUPS implementation upgrade sequence...");

        DRIFTCore core = DRIFTCore(proxyAddr);

        DRIFTCore newImpl = new DRIFTCore();
        console2.log("New implementation:", address(newImpl));

        // Upgrade via UUPS
        core.upgradeToAndCall(address(newImpl), "");
        console2.log("Core upgraded successfully.");

        _preserveAndUpdateImpl(proxyAddr, address(newImpl));

        console2.log("WARNING: Factory and template addresses are preserved.");
        console2.log("         Deploy new versions manually if they also changed.");
        console2.log("Upgrade complete.");
    }

    // Storage Lookups =========================================================

    function _loadExistingProxyAddress() internal view returns (address) {
        if (!vm.exists(deploymentPath)) return address(0);
        string memory fileContent = vm.readFile(deploymentPath);
        try vm.parseJsonAddress(fileContent, ".DRIFTCore") returns (address proxyAddr) {
            return proxyAddr;
        } catch {
            return address(0);
        }
    }

    // Serialization ===========================================================

    function _serialize(address core, address coreImpl, address token, address factory, address wgTemplate) internal {
        jsonOutput = vm.serializeAddress(JSON_KEY, "DRIFTCore", core);
        jsonOutput = vm.serializeAddress(JSON_KEY, "DRIFTCoreImplementation", coreImpl);
        jsonOutput = vm.serializeAddress(JSON_KEY, "DRIFTToken", token);
        jsonOutput = vm.serializeAddress(JSON_KEY, "Factory", factory);
        jsonOutput = vm.serializeAddress(JSON_KEY, "WeightedGovernanceTemplate", wgTemplate);
    }

    function _preserveAndUpdateImpl(address proxyAddr, address newImpl) internal {
        string memory old = vm.readFile(deploymentPath);

        jsonOutput = vm.serializeAddress(JSON_KEY, "DRIFTCore", proxyAddr);
        jsonOutput = vm.serializeAddress(JSON_KEY, "DRIFTCoreImplementation", newImpl);
        jsonOutput = vm.serializeAddress(JSON_KEY, "DRIFTToken", vm.parseJsonAddress(old, ".DRIFTToken"));
        jsonOutput = vm.serializeAddress(JSON_KEY, "Factory", vm.parseJsonAddress(old, ".Factory"));
        jsonOutput = vm.serializeAddress(
            JSON_KEY,
            "WeightedGovernanceTemplate",
            vm.parseJsonAddress(old, ".WeightedGovernanceTemplate")
        );
    }
}
