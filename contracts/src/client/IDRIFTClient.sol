// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IDRIFTCore } from "../core/IDRIFTCore.sol";

/// @title IDRIFTClient
/// @notice The base interface for all DRIFT Context Clients.
interface IDRIFTClient {
    /// @notice Returns the address of the central DRIFT registry.
    function core() external view returns (IDRIFTCore);

    /// @notice Returns the unique identifier of this client's context.
    function contextUID() external view returns (bytes32);
}
