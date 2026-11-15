// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test-only stand-in for dstack's DstackApp. It is NOT dstack's contract: it
/// only has an owner and the compose-hash functions, with the same names and
/// argument types as the two DstackApp generations, so the tests can prove
/// that the calls upgrades.mjs schedules are accepted from the owner and
/// refused from anyone else.
contract ComposeHashStandIn {
    address public owner;
    uint256 public currentAppEpoch;
    mapping(bytes32 => bool) public allowedComposeHashes;
    mapping(uint256 => mapping(bytes32 => bool)) private _byEpoch;
    bytes4 private immutable _managementInterface;

    constructor(address initialOwner, bytes4 managementInterface) {
        owner = initialOwner;
        _managementInterface = managementInterface;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function supportsInterface(bytes4 interfaceId) external view returns (bool) {
        return interfaceId == _managementInterface || interfaceId == 0x01ffc9a7;
    }

    // Shape of DstackApp v0.5.9 and v0.6.0.
    function addComposeHash(bytes32 composeHash) external onlyOwner {
        allowedComposeHashes[composeHash] = true;
    }

    function removeComposeHash(bytes32 composeHash) external onlyOwner {
        allowedComposeHashes[composeHash] = false;
    }

    // Shape of DstackApp on the `next` branch (app epochs).
    function allowedComposeHashesAtEpoch(uint256 epoch, bytes32 composeHash) public view returns (bool) {
        return epoch == 0 ? allowedComposeHashes[composeHash] : _byEpoch[epoch][composeHash];
    }

    function addComposeHashAtEpoch(uint256 epoch, bytes32 composeHash) external onlyOwner {
        _set(epoch, composeHash, true);
    }

    function removeComposeHashAtEpochs(uint256 fromEpoch, uint256 toEpoch, bytes32 composeHash) external onlyOwner {
        require(fromEpoch <= toEpoch, "Invalid app epoch range");
        for (uint256 epoch = fromEpoch; epoch <= toEpoch; ++epoch) {
            _set(epoch, composeHash, false);
        }
    }

    function advanceAppEpoch(uint256 expectedCurrentEpoch) external onlyOwner {
        require(currentAppEpoch == expectedCurrentEpoch, "App epoch changed");
        currentAppEpoch++;
    }

    function _set(uint256 epoch, bytes32 composeHash, bool allowed) private {
        require(epoch <= currentAppEpoch + 1, "Unknown app epoch");
        if (epoch == 0) allowedComposeHashes[composeHash] = allowed;
        else _byEpoch[epoch][composeHash] = allowed;
    }
}
