// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IDRIFTClientMetadata
/// @notice Optional extension for DRIFT Clients to provide frontend/UI metadata.
interface IDRIFTClientMetadata {
    /// @notice Returns the Semantic Version of the client (e.g., "1.0.0").
    function version() external pure returns (string memory);

    /// @notice Returns human-readable metadata about this client.
    function metadata() external view returns (string memory name, string memory description);
}
