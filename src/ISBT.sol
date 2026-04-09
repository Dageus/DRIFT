// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IDRIFT_Identity {
    struct Identity {
        uint256 joinTimestamp;
        uint256 initialStake;
        uint256 perfScore;
        bool isBanned;
    }

    function getIdentity(address node) external view returns (Identity memory);
    function mint(address to, uint256 stakedAmount) external;
    function updateReputation(address node, uint256 newScore) external;
    function banNode(address node) external;
}
