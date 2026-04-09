import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-foundry";

const config: HardhatUserConfig = {
  paths: {
    sources: "./src",
  },
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "paris",
      optimizer: {
        enabled: true,
        runs: 200, // Important for gas efficiency
      },
    },
  },
};

export default config;
