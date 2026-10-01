//! DRIFT engine server: runs Phi_c behind the gRPC protocol in packages/protos/drift/engine/v1.
//!
//! Evidence modes, matching the trust tiers:
//!   none    the caller trusts this server (development, or a settler running its own engine)
//!   signed  the server signs each journal with its key; a committee of such servers with a
//!           t-of-n check on the client is Tier 2
//!   risc0   the server proves each run in the zkVM (Tier 3, build with --features risc0)

mod convert;
mod evidence;

use std::net::SocketAddr;

use alloy_sol_types::SolValue;
use clap::{Parser, ValueEnum};
use drift_engine_core::{canonicalize, compute, engine_id, ENGINE_NAME};
use tonic::{transport::Server, Request, Response, Status};

use evidence::Evidence;

pub mod pb {
    tonic::include_proto!("drift.engine.v1");
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum EvidenceKind {
    None,
    Signed,
    #[cfg(feature = "risc0")]
    Risc0,
}

#[derive(Parser, Debug)]
#[command(version, about)]
struct Args {
    #[arg(long, env = "DRIFT_ENGINE_LISTEN", default_value = "127.0.0.1:50051")]
    listen: SocketAddr,
    #[arg(long, env = "DRIFT_ENGINE_EVIDENCE", value_enum, default_value = "none")]
    evidence: EvidenceKind,
    /// Hex secp256k1 key for `--evidence signed`. Read from the environment, never from argv,
    /// so it does not show up in the process list.
    #[arg(long, env = "DRIFT_ENGINE_SIGNING_KEY", hide_env_values = true)]
    signing_key: Option<String>,
}

struct EngineService {
    evidence: Evidence,
}

#[tonic::async_trait]
impl pb::reputation_engine_server::ReputationEngine for EngineService {
    async fn compute_epoch(
        &self,
        request: Request<pb::ComputeEpochRequest>,
    ) -> Result<Response<pb::ComputeEpochResponse>, Status> {
        let mut input = convert::input_from_request(request.into_inner())?;
        canonicalize(&mut input);

        let evidence = self.evidence.clone();
        // Phi_c and proving are CPU bound; keep them off the async executor.
        let response = tokio::task::spawn_blocking(move || -> Result<pb::ComputeEpochResponse, Status> {
            let out = compute(&input).map_err(|e| Status::invalid_argument(e.to_string()))?;
            let journal = out.journal.abi_encode();
            let mut resp = convert::response_from_output(&out, journal.clone());
            resp.evidence = evidence.produce(&input, &journal)?;
            Ok(resp)
        })
        .await
        .map_err(|e| Status::internal(format!("engine task failed: {e}")))??;

        Ok(Response::new(response))
    }

    async fn describe(&self, _: Request<pb::DescribeRequest>) -> Result<Response<pb::DescribeResponse>, Status> {
        let mut resp = pb::DescribeResponse {
            engine_id: engine_id().to_vec(),
            engine_name: ENGINE_NAME.to_string(),
            evidence_kind: self.evidence.kind().to_string(),
            ..Default::default()
        };
        self.evidence.describe(&mut resp);
        Ok(Response::new(resp))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let args = Args::parse();

    let evidence = match args.evidence {
        EvidenceKind::None => Evidence::None,
        EvidenceKind::Signed => {
            let key = args.signing_key.ok_or("--evidence signed needs DRIFT_ENGINE_SIGNING_KEY")?;
            Evidence::signed(&key)?
        }
        #[cfg(feature = "risc0")]
        EvidenceKind::Risc0 => Evidence::Risc0,
    };
    tracing::info!(listen = %args.listen, evidence = evidence.kind(), engine = ENGINE_NAME, "starting");

    Server::builder()
        .add_service(
            pb::reputation_engine_server::ReputationEngineServer::new(EngineService { evidence })
                .max_decoding_message_size(256 * 1024 * 1024),
        )
        .serve_with_shutdown(args.listen, async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
