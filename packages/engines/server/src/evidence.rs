//! Evidence that binds a journal to the engine that produced it.

use alloy_primitives::{eip191_hash_message, keccak256, Address};
use drift_engine_core::EngineInput;
use k256::ecdsa::SigningKey;
use tonic::Status;

use crate::pb;

#[derive(Clone)]
pub enum Evidence {
    None,
    Signed { key: SigningKey, address: Address },
    #[cfg(feature = "risc0")]
    Risc0,
}

impl Evidence {
    pub fn signed(hex_key: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let bytes = alloy_primitives::hex::decode(hex_key.trim())?;
        let key = SigningKey::from_slice(&bytes)?;
        let address = Address::from_private_key(&key);
        Ok(Evidence::Signed { key, address })
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Evidence::None => "none",
            Evidence::Signed { .. } => "signed",
            #[cfg(feature = "risc0")]
            Evidence::Risc0 => "risc0",
        }
    }

    pub fn describe(&self, resp: &mut pb::DescribeResponse) {
        match self {
            Evidence::None => {}
            Evidence::Signed { address, .. } => resp.signer = address.to_vec(),
            #[cfg(feature = "risc0")]
            Evidence::Risc0 => resp.image_id = risc0::image_id(),
        }
    }

    /// `input` must be the canonicalized input the journal was computed from.
    #[allow(unused_variables)]
    pub fn produce(&self, input: &EngineInput, journal: &[u8]) -> Result<Option<pb::compute_epoch_response::Evidence>, Status> {
        match self {
            Evidence::None => Ok(None),
            Evidence::Signed { key, address } => {
                // EIP-191 over keccak256(journal), so ethers' verifyMessage and OpenZeppelin's
                // ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(keccak256(journal))) agree.
                let digest = eip191_hash_message(keccak256(journal));
                let (sig, recid) = key
                    .sign_prehash_recoverable(digest.as_slice())
                    .map_err(|e| Status::internal(format!("signing failed: {e}")))?;
                let mut signature = sig.to_bytes().to_vec();
                signature.push(27 + recid.to_byte());
                Ok(Some(pb::compute_epoch_response::Evidence::Signed(pb::SignedJournal {
                    signer: address.to_vec(),
                    signature,
                })))
            }
            #[cfg(feature = "risc0")]
            Evidence::Risc0 => risc0::prove(input, journal).map(Some),
        }
    }
}

#[cfg(feature = "risc0")]
mod risc0 {
    use alloy_sol_types::SolValue;
    use drift_engine_core::EngineInput;
    use drift_engine_methods::{DRIFT_ENGINE_GUEST_ELF, DRIFT_ENGINE_GUEST_ID};
    use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts};
    use tonic::Status;

    use crate::pb;

    pub fn image_id() -> Vec<u8> {
        risc0_zkvm::sha::Digest::from(DRIFT_ENGINE_GUEST_ID).as_bytes().to_vec()
    }

    pub fn prove(input: &EngineInput, expected_journal: &[u8]) -> Result<pb::compute_epoch_response::Evidence, Status> {
        let env = ExecutorEnv::builder()
            .write_slice(&input.abi_encode())
            .build()
            .map_err(|e| Status::internal(format!("zkvm env: {e}")))?;
        // Succinct receipts verify off chain. An on-chain verifier needs ProverOpts::groth16()
        // and risc0_ethereum_contracts::encode_seal; that lands with the contract-side verifier.
        let info = default_prover()
            .prove_with_opts(env, DRIFT_ENGINE_GUEST_ELF, &ProverOpts::succinct())
            .map_err(|e| Status::internal(format!("proving failed: {e}")))?;
        tracing::info!(
            total_cycles = info.stats.total_cycles,
            user_cycles = info.stats.user_cycles,
            segments = info.stats.segments,
            records = input.records.len(),
            members = input.members.len(),
            "proved epoch"
        );
        if info.receipt.journal.bytes != expected_journal {
            return Err(Status::internal("guest journal differs from the host computation"));
        }
        let receipt = bincode::serialize(&info.receipt).map_err(|e| Status::internal(e.to_string()))?;
        Ok(pb::compute_epoch_response::Evidence::Risc0(pb::Risc0Receipt { image_id: image_id(), seal: Vec::new(), receipt }))
    }
}
