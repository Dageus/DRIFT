{
  description = "DRIFT: Solidity Development Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
      ...
    }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
      };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        buildInputs = with pkgs; [
          foundry
          solc
          nodejs_22
        ];

        shellHook = ''
          echo "DRIFT Environment Active"
          echo "Foundry: $(forge --version)"
          echo "Node: $(node --version)"
        '';
      };
    };
}
