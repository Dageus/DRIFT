// Bundles the engine protocol definition into the package (proto/), so GrpcEpochEngine finds it
// in an installed copy, not only inside this repository.
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../protos', import.meta.url));
const dst = fileURLToPath(new URL('../proto', import.meta.url));
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
