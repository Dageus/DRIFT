export type { IEpochEngine } from './IEpochEngine.js';
export { LocalEpochEngine } from './LocalEpochEngine.js';
export {
  ENGINE_NAME,
  ENGINE_ID,
  DEFAULT_EIGENTRUST_PARAMS,
  canonicalize,
  encodeInput,
  inputDigest,
  encodeJournal,
  decodeJournal,
  schemaWidth,
  validateInput,
  settle,
  journalHash
} from './protocol.js';
export type { EigenTrustParams, EpochMember, EpochInput, EngineJournal, EngineEvidence, EpochResult } from './protocol.js';
