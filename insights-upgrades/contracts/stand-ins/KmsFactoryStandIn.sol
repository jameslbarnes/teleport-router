// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test-only stand-ins for dstack's key service factory (DstackKms) and the
/// app contract it creates. They are NOT dstack's contracts. They have the
/// factory function, the event and the read functions that `create-app` uses,
/// with the same names and argument types, so the tests can prove the call is
/// encoded correctly, that the owner is set to the address passed in, and
/// that the checks afterwards read what was written.
contract FactoryAppStandIn {
    address public owner;
    bool public upgradesDisabled;
    bool public requireTcbUpToDate;
    bool public allowAnyDevice;
    mapping(bytes32 => bool) public allowedDeviceIds;
    mapping(bytes32 => bool) public allowedComposeHashes;

    constructor(
        address initialOwner,
        bool disableUpgrades,
        bool requireTcbUpToDate_,
        bool allowAnyDevice_,
        bytes32 initialDeviceId,
        bytes32 initialComposeHash
    ) {
        require(initialOwner != address(0), "invalid owner address");
        owner = initialOwner;
        upgradesDisabled = disableUpgrades;
        requireTcbUpToDate = requireTcbUpToDate_;
        allowAnyDevice = allowAnyDevice_;
        if (initialDeviceId != bytes32(0)) allowedDeviceIds[initialDeviceId] = true;
        if (initialComposeHash != bytes32(0)) allowedComposeHashes[initialComposeHash] = true;
    }

    // IAppAuthBasicManagement (0x8fd37527) and ERC-165.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x8fd37527 || interfaceId == 0x01ffc9a7;
    }

    function addComposeHash(bytes32 composeHash) external {
        require(msg.sender == owner, "not owner");
        allowedComposeHashes[composeHash] = true;
    }

    function removeComposeHash(bytes32 composeHash) external {
        require(msg.sender == owner, "not owner");
        allowedComposeHashes[composeHash] = false;
    }
}

contract KmsFactoryStandIn {
    mapping(address => bool) public registeredApps;

    event AppDeployedViaFactory(address indexed appId, address indexed deployer);

    function deployAndRegisterApp(
        address initialOwner,
        bool disableUpgrades,
        bool requireTcbUpToDate,
        bool allowAnyDevice,
        bytes32 initialDeviceId,
        bytes32 initialComposeHash
    ) public returns (address appId) {
        appId = address(
            new FactoryAppStandIn(
                initialOwner, disableUpgrades, requireTcbUpToDate, allowAnyDevice, initialDeviceId, initialComposeHash
            )
        );
        registeredApps[appId] = true;
        emit AppDeployedViaFactory(appId, msg.sender);
    }
}
