fn main() {
    // Set RISC0_SKIP_BUILD=1 to type-check the host without the risc0 toolchain; the ELF is then
    // empty and proving fails at run time.
    risc0_build::embed_methods();
}
