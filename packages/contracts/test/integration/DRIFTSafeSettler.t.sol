// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { DRIFTClientFactory } from "../../src/client/DRIFTClientFactory.sol";
import { IDRIFTSettler } from "../../src/client/IDRIFTSettler.sol";
import { DRIFTCore } from "../../src/core/DRIFTCore.sol";
import { WeightedGovernanceClient } from "../../src/templates/WeightedGovernance.sol";
import { DRIFTToken } from "../../src/token/DRIFTToken.sol";
import { DRIFTTestHelper } from "../utils/DRIFTTestHelper.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { console } from "forge-std/console.sol";

/// @dev The slice of the Safe v1.4.1 interface these tests use.
interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);

    function nonce() external view returns (uint256);
    function domainSeparator() external view returns (bytes32);
    function signedMessages(
        bytes32
    ) external view returns (uint256);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(
        address singleton,
        bytes memory initializer,
        uint256 saltNonce
    ) external returns (address);
}

interface ISignMessageLib {
    function signMessage(
        bytes calldata data
    ) external;
}

interface IMultiSend {
    function multiSend(
        bytes memory transactions
    ) external payable;
}

/// @title DRIFTSafeSettlerTest
/// @notice Tier 2 settlement: the trusted settler is a 2-of-3 Safe whose owners are independent
///         engine operators. Runs against the real Safe v1.4.1 runtime bytecode, fetched from
///         Arbitrum Sepolia (identical on Sepolia) and etched at its canonical addresses; see
///         test/fixtures/safe-v1.4.1/README.md. No DRIFT contract changes are involved: the
///         client already requires msg.sender == trustedSettler and checks the settler signature
///         with OpenZeppelin's SignatureChecker, which falls through to ERC-1271 for contracts.
contract DRIFTSafeSettlerTest is DRIFTTestHelper {
    address constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant MULTI_SEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526;
    address constant FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address constant SIGN_MESSAGE_LIB = 0xd53cd0aB83D845Ac265BE939c57F53AD838012c9;

    bytes32 constant SETTLE_ROOT_TYPEHASH =
        keccak256("SettleRoot(bytes32 contextUID,uint256 epoch,bytes32 merkleRoot,string treeURI)");
    bytes32 constant SAFE_MSG_TYPEHASH = keccak256("SafeMessage(bytes message)");

    uint8 constant CALL = 0;
    uint8 constant DELEGATECALL = 1;

    DRIFTCore public core;
    DRIFTToken public driftToken;
    DRIFTClientFactory public factory;
    WeightedGovernanceClient public client;
    ISafe public safe;

    address public admin = makeAddr("admin");
    address public relayer = makeAddr("relayer");
    bytes32 public contextUID;
    bytes32 constant ROLE = keccak256("ROLE");

    // Owner keys are shared with the SDK vector (packages/sdk/test/local/safe-settler.test.ts).
    uint256[3] internal ownerPks = [uint256(0x5afe01), uint256(0x5afe02), uint256(0x5afe03)];

    uint256 constant EPOCH_LENGTH = 10;
    uint256 constant DISPUTE_WINDOW = 2;
    uint256 constant RESPONSE_WINDOW = 2;
    uint256 constant SETTLEMENT_BOND = 0.01 ether;
    uint256 constant CHALLENGE_BOND = 0.01 ether;

    function setUp() public {
        _etch(SAFE_SINGLETON, "Safe");
        _etch(SAFE_PROXY_FACTORY, "SafeProxyFactory");
        _etch(MULTI_SEND, "MultiSend");
        _etch(FALLBACK_HANDLER, "CompatibilityFallbackHandler");
        _etch(SIGN_MESSAGE_LIB, "SignMessageLib");

        address[] memory owners = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            owners[i] = vm.addr(ownerPks[i]);
        }
        bytes memory init = abi.encodeCall(
            ISafe.setup,
            (owners, 2, address(0), "", FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
        safe = ISafe(
            ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_SINGLETON, init, 0)
        );
        vm.deal(address(safe), 1 ether);

        DRIFTCore coreImpl = new DRIFTCore();
        core = DRIFTCore(
            address(
                new ERC1967Proxy(
                    address(coreImpl), abi.encodeWithSelector(DRIFTCore.initialize.selector, admin)
                )
            )
        );
        driftToken = new DRIFTToken(address(core));
        vm.prank(admin);
        core.setDriftToken(address(driftToken));
        WeightedGovernanceClient template = new WeightedGovernanceClient();
        factory = new DRIFTClientFactory(address(core));

        vm.startPrank(admin);
        core.grantRole(core.FACTORY_ROLE(), address(factory));
        contextUID = core.registerContext("safe.test");
        bytes32[] memory roles = new bytes32[](1);
        roles[0] = ROLE;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;
        bytes memory initData = abi.encodeWithSelector(
            WeightedGovernanceClient.initialize.selector,
            address(core),
            address(driftToken),
            contextUID,
            address(safe),
            0,
            0,
            "EigenTrust",
            roles,
            weights
        );
        client = WeightedGovernanceClient(
            factory.deployClient(contextUID, address(template), initData, bytes32("salt"))
        );
        core.grantRole(core.contextAdminRole(contextUID), address(client));
        client.setEpochLength(EPOCH_LENGTH);
        client.setDisputeWindow(DISPUTE_WINDOW);
        client.setResponseWindow(RESPONSE_WINDOW);
        client.setSettlementBond(SETTLEMENT_BOND);
        client.setChallengeBond(CHALLENGE_BOND);
        vm.stopPrank();
    }

    // HELPERS =================================================================

    function _etch(
        address at,
        string memory name
    ) internal {
        string memory path =
            string.concat(vm.projectRoot(), "/test/fixtures/safe-v1.4.1/", name, ".hex");
        vm.etch(at, vm.parseBytes(vm.readFile(path)));
    }

    function _settleDigest(
        uint256 epoch,
        bytes32 root,
        string memory treeURI
    ) internal view returns (bytes32) {
        (, string memory dName, string memory dVersion, uint256 chainId, address verifying,,) =
            client.eip712Domain();
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(dName)),
                keccak256(bytes(dVersion)),
                chainId,
                verifying
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(SETTLE_ROOT_TYPEHASH, contextUID, epoch, root, keccak256(bytes(treeURI)))
        );
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    function _oneRoundData(
        uint256 epoch,
        bytes32 root,
        string memory treeURI
    ) internal view returns (bytes memory) {
        bytes memory signMsg = abi.encodeCall(
            ISignMessageLib.signMessage, (abi.encode(_settleDigest(epoch, root, treeURI)))
        );
        bytes memory post = abi.encodeCall(
            WeightedGovernanceClient.postEpochRoot, (epoch, root, treeURI, bytes(""))
        );
        bytes memory txs = abi.encodePacked(
            DELEGATECALL,
            SIGN_MESSAGE_LIB,
            uint256(0),
            signMsg.length,
            signMsg,
            CALL,
            address(client),
            SETTLEMENT_BOND,
            post.length,
            post
        );
        return abi.encodeCall(IMultiSend.multiSend, (txs));
    }

    function _txHash(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation
    ) internal view returns (bytes32) {
        return safe.getTransactionHash(
            to, value, data, operation, 0, 0, 0, address(0), address(0), safe.nonce()
        );
    }

    /// @dev Signs `hash` with the owners at `idx` and packs the signatures in ascending owner
    ///      order, as Safe.checkSignatures requires.
    function _ownerSigs(
        bytes32 hash,
        uint256[] memory idx
    ) internal view returns (bytes memory packed) {
        uint256[] memory pks = new uint256[](idx.length);
        for (uint256 i = 0; i < idx.length; i++) {
            pks[i] = ownerPks[idx[i]];
        }
        for (uint256 i = 0; i < pks.length; i++) {
            for (uint256 j = i + 1; j < pks.length; j++) {
                if (vm.addr(pks[j]) < vm.addr(pks[i])) (pks[i], pks[j]) = (pks[j], pks[i]);
            }
        }
        for (uint256 i = 0; i < pks.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], hash);
            packed = abi.encodePacked(packed, r, s, v);
        }
    }

    function _pair(
        uint256 a,
        uint256 b
    ) internal pure returns (uint256[] memory idx) {
        idx = new uint256[](2);
        idx[0] = a;
        idx[1] = b;
    }

    function _exec(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation,
        bytes memory sigs
    ) internal {
        vm.prank(relayer);
        safe.execTransaction(
            to, value, data, operation, 0, 0, 0, address(0), payable(address(0)), sigs
        );
    }

    function _settleOneRound(
        uint256 epoch,
        bytes32 root
    ) internal {
        vm.warp(client.epochAnchorTimestamp() + EPOCH_LENGTH * epoch);
        bytes memory data = _oneRoundData(epoch, root, "");
        bytes32 h = _txHash(MULTI_SEND, 0, data, DELEGATECALL);
        _exec(MULTI_SEND, 0, data, DELEGATECALL, _ownerSigs(h, _pair(0, 2)));
    }

    function _leaf(
        address node,
        uint256 score,
        uint256 epoch
    ) internal view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(contextUID, node, ROLE, score, epoch))));
    }

    // SETTLEMENT ==============================================================

    /// @notice One Safe transaction, one round of owner signatures: MultiSend marks the
    ///         SettleRoot digest as signed (SignMessageLib) and posts the root with an empty
    ///         signature, which the client accepts through the Safe's ERC-1271 handler.
    function test_SafeSettles_OneRound() public {
        bytes32 root = keccak256("root");
        uint256 safeBalance = address(safe).balance;
        vm.warp(client.epochAnchorTimestamp() + EPOCH_LENGTH);
        bytes memory data = _oneRoundData(1, root, "");
        bytes memory sigs = _ownerSigs(_txHash(MULTI_SEND, 0, data, DELEGATECALL), _pair(0, 2));

        // Same method and conditions as PostRoot_O1_Cost in DRIFTMerkleGas.t.sol (first epoch,
        // execution gas only), so the difference is the cost of a 2-of-3 Safe as settler.
        vm.prank(relayer);
        vm.startSnapshotGas("PostRoot_Safe2of3_OneRound");
        safe.execTransaction(
            MULTI_SEND, 0, data, DELEGATECALL, 0, 0, 0, address(0), payable(address(0)), sigs
        );
        vm.stopSnapshotGas();

        assertEq(client.epochRoots(1), root);
        assertEq(client.currentEpoch(), 1);
        assertEq(address(safe).balance, safeBalance - SETTLEMENT_BOND);
        assertEq(client.epochBondAmount(1), SETTLEMENT_BOND);
    }

    /// @notice Two rounds: owners sign the SafeMessage for the SettleRoot digest, the packed
    ///         signatures go into postEpochRoot's `sig`, and owners then sign the plain call.
    function test_SafeSettles_TwoRound() public {
        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        vm.warp(client.epochAnchorTimestamp() + EPOCH_LENGTH * epoch);

        bytes32 digest = _settleDigest(epoch, root, "");
        bytes32 msgHash = keccak256(
            abi.encodePacked(
                bytes1(0x19),
                bytes1(0x01),
                safe.domainSeparator(),
                keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(abi.encode(digest))))
            )
        );
        bytes memory erc1271Sig = _ownerSigs(msgHash, _pair(1, 2));

        bytes memory data =
            abi.encodeCall(WeightedGovernanceClient.postEpochRoot, (epoch, root, "", erc1271Sig));
        bytes32 h = _txHash(address(client), SETTLEMENT_BOND, data, CALL);
        bytes memory sigs = _ownerSigs(h, _pair(0, 1));
        vm.prank(relayer);
        vm.startSnapshotGas("PostRoot_Safe2of3_TwoRound");
        safe.execTransaction(
            address(client),
            SETTLEMENT_BOND,
            data,
            CALL,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            sigs
        );
        vm.stopSnapshotGas();

        assertEq(client.epochRoots(epoch), root);
    }

    /// @notice One owner alone cannot settle: the Safe rejects the transaction (GS020) and no
    ///         root is posted.
    function test_RevertIf_BelowThreshold() public {
        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        vm.warp(client.epochAnchorTimestamp() + EPOCH_LENGTH * epoch);
        bytes memory data = _oneRoundData(epoch, root, "");
        bytes32 h = _txHash(MULTI_SEND, 0, data, DELEGATECALL);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPks[0], h);

        vm.expectRevert(bytes("GS020"));
        _exec(MULTI_SEND, 0, data, DELEGATECALL, abi.encodePacked(r, s, v));
        assertEq(client.epochRoots(epoch), bytes32(0));
    }

    /// @notice Owners whose engines computed different roots sign different transactions, so
    ///         their signatures never combine: two owners split across two roots settle neither.
    function test_RevertIf_OwnersSignDifferentRoots() public {
        uint256 epoch = 1;
        vm.warp(client.epochAnchorTimestamp() + EPOCH_LENGTH * epoch);
        bytes memory dataA = _oneRoundData(epoch, keccak256("rootA"), "");
        bytes memory dataB = _oneRoundData(epoch, keccak256("rootB"), "");
        bytes32 hA = _txHash(MULTI_SEND, 0, dataA, DELEGATECALL);
        bytes32 hB = _txHash(MULTI_SEND, 0, dataB, DELEGATECALL);

        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(ownerPks[0], hA);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(ownerPks[1], hB);
        (address o0, address o1) = (vm.addr(ownerPks[0]), vm.addr(ownerPks[1]));
        bytes memory mixed = o0 < o1
            ? abi.encodePacked(r0, s0, v0, r1, s1, v1)
            : abi.encodePacked(r1, s1, v1, r0, s0, v0);

        // Against hA, owner 1's signature recovers to a non-owner address.
        vm.expectRevert(bytes("GS026"));
        _exec(MULTI_SEND, 0, dataA, DELEGATECALL, mixed);
        assertEq(client.epochRoots(epoch), bytes32(0));
    }

    /// @notice The client still rejects a direct postEpochRoot from an owner key: authority sits
    ///         with the Safe, not with any individual operator.
    function test_RevertIf_OwnerPostsDirectly() public {
        uint256 epoch = 1;
        bytes32 root = keccak256("root");
        vm.warp(client.epochAnchorTimestamp() + EPOCH_LENGTH * epoch);
        address owner0 = vm.addr(ownerPks[0]);
        bytes memory sig = _signEpochRoot(ownerPks[0], contextUID, epoch, root, address(client));
        vm.deal(owner0, 1 ether);
        vm.prank(owner0);
        vm.expectRevert(abi.encodeWithSelector(IDRIFTSettler.NotTrustedSettler.selector, owner0));
        client.postEpochRoot{ value: SETTLEMENT_BOND }(epoch, root, "", sig);
    }

    // BOND FLOWS ==============================================================

    /// @notice A forfeited challenge bond reaches the Safe within _payOrCredit's gas stipend, so
    ///         it is paid directly rather than deferred to pendingPayouts.
    function test_SafeReceivesForfeitedChallengeBond() public {
        address node = makeAddr("node");
        vm.prank(node);
        core.registerNode(contextUID, "0x");
        vm.prank(admin);
        client.assignRole(node, ROLE);
        address challenger = makeAddr("challenger");
        vm.prank(challenger);
        core.registerNode(contextUID, "0x");

        uint256 score = 100;
        _settleOneRound(1, _leaf(node, score, 1));

        vm.deal(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        client.challengeOmission{ value: CHALLENGE_BOND }(1, node, ROLE);

        uint256 before = address(safe).balance;
        client.respondToChallenge(1, node, ROLE, score, new bytes32[](0));

        assertEq(address(safe).balance, before + CHALLENGE_BOND);
        assertEq(client.pendingPayouts(address(safe)), 0);
    }

    /// @notice After finalization the settlement bond returns to the Safe.
    function test_SafeWithdrawsSettlementBond() public {
        _settleOneRound(1, keccak256("root"));
        vm.warp(vm.getBlockTimestamp() + DISPUTE_WINDOW + RESPONSE_WINDOW + 1);

        uint256 before = address(safe).balance;
        client.withdrawSettlementBond(1);
        assertEq(address(safe).balance, before + SETTLEMENT_BOND);
    }

    // SDK CROSS-CHECK =========================================================

    /// @notice Executes the transaction and signatures the TypeScript SafeSettler produced for
    ///         this deployment (packages/sdk/test/local/safe-settler.test.ts writes the vector).
    ///         A mismatch in any hash or encoding makes the Safe or the client reject it.
    function test_ExecutesSdkBuiltSettlement() public {
        string memory json = vm.readFile(
            string.concat(vm.projectRoot(), "/test/fixtures/safe-settler-vector.json")
        );
        assertEq(
            vm.parseJsonAddress(json, ".inputs.safe"), address(safe), "regenerate vector: safe"
        );
        assertEq(
            vm.parseJsonAddress(json, ".inputs.client"),
            address(client),
            "regenerate vector: client"
        );
        assertEq(vm.parseJsonBytes32(json, ".inputs.contextUID"), contextUID, "vector: context");
        assertEq(vm.parseJsonUint(json, ".inputs.chainId"), block.chainid, "vector: chain id");

        uint256 epoch = vm.parseJsonUint(json, ".inputs.epoch");
        bytes32 root = vm.parseJsonBytes32(json, ".inputs.merkleRoot");
        string memory treeURI = vm.parseJsonString(json, ".inputs.treeURI");
        bytes memory data = vm.parseJsonBytes(json, ".expected.data");

        assertEq(
            vm.parseJsonBytes32(json, ".expected.settleDigest"),
            _settleDigest(epoch, root, treeURI),
            "settle digest"
        );
        assertEq(data, _oneRoundData(epoch, root, treeURI), "multisend data");
        assertEq(
            vm.parseJsonBytes32(json, ".expected.safeTxHash"),
            _txHash(MULTI_SEND, 0, data, DELEGATECALL),
            "safe tx hash"
        );

        vm.warp(client.epochAnchorTimestamp() + EPOCH_LENGTH * epoch);
        _exec(MULTI_SEND, 0, data, DELEGATECALL, vm.parseJsonBytes(json, ".expected.signatures"));
        assertEq(client.epochRoots(epoch), root);
    }

    /// @notice Prints the deployment the SDK vector must target.
    function test_PrintVectorInputs() public view {
        (, string memory dName, string memory dVersion,,,,) = client.eip712Domain();
        console.log("safe", address(safe));
        console.log("client", address(client));
        console.logBytes32(contextUID);
        console.log("chainId", block.chainid);
        console.log("domain", dName, dVersion);
    }
}
