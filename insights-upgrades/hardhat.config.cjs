// Used only by upgrades.test.mjs: a local test chain and a compiler for the
// stand-in contract in test-contracts/. Nothing here points at a real network.
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: {
    sources: "./test-contracts",
    artifacts: "./test-artifacts",
    cache: "./test-cache",
  },
  networks: {
    hardhat: { chainId: 31337 },
  },
};
