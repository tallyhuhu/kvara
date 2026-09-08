// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract KvaraProfileRegistry {
    enum Role {
        None,
        Resident,
        Landlord,
        Both
    }

    mapping(address account => Role role) public profileOf;

    event ProfileSet(address indexed account, Role role);

    error InvalidRole();

    function setProfile(Role role) external {
        if (role == Role.None) revert InvalidRole();
        profileOf[msg.sender] = role;
        emit ProfileSet(msg.sender, role);
    }
}
