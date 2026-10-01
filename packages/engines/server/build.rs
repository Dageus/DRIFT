fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The protocol lives outside the Rust workspace so the TypeScript client loads the same file.
    let protos = "../../protos";
    tonic_prost_build::configure()
        .build_client(false)
        .compile_protos(&[format!("{protos}/drift/engine/v1/engine.proto")], &[protos.to_string()])?;
    println!("cargo:rerun-if-changed={protos}");
    Ok(())
}
