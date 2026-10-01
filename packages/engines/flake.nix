{
  description = "DRIFT reputation engines (Rust): core, gRPC server, RISC Zero guest";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    risc0-nix = {
      url = "github:alpenlabs/risc0.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      risc0-nix,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        common = with pkgs; [
          cargo
          rustc
          rustfmt
          clippy
          protobuf
          pkg-config
        ];
      in
      {
        # Core and server (Tier 1 and Tier 2): a stock toolchain is enough.
        devShells.default = pkgs.mkShell {
          packages = common;
          PROTOC = "${pkgs.protobuf}/bin/protoc";
        };

        # Tier 3: risc0-build finds the guest toolchain only through rzup's directory layout
        # ($RISC0_HOME/toolchains/v<version>-rust-<platform>). This shell builds that layout in
        # .risc0-home/ pointing at the Nix-built toolchain, so no rzup install is needed.
        devShells.risc0 =
          let
            toolchain = risc0-nix.packages.${system}.risc0-toolchain;
          in
          pkgs.mkShell {
            packages = common;
            PROTOC = "${pkgs.protobuf}/bin/protoc";
            shellHook = ''
              version=$(${toolchain}/bin/rustc --version | cut -d' ' -f2 | cut -d- -f1)
              platform=$(${toolchain}/bin/rustc -vV | sed -n 's/^host: //p')
              export RISC0_HOME="$PWD/.risc0-home"
              mkdir -p "$RISC0_HOME/toolchains"
              # rzup ignores symlinked version directories, so link the contents instead.
              dir="$RISC0_HOME/toolchains/v$version-rust-$platform"
              rm -rf "$dir" && mkdir -p "$dir"
              ln -s ${toolchain}/bin ${toolchain}/lib "$dir/"
              printf '[default_versions]\nrust = "%s"\n' "$version" > "$RISC0_HOME/settings.toml"
              echo "risc0 guest toolchain: rust $version ($RISC0_HOME)"
            '';
          };
      }
    );
}
