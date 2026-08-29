# DRIFT Security Audit

Final-pass security audit of the shipped contracts (`packages/contracts/src/`), combining
Slither static analysis with a manual review of everything Slither cannot see (access-control
wiring, cross-contract trust assumptions, storage/token lifecycle correctness). Produced for the
dissertation's security argument — cite the triage table and the four fixed findings as evidence
of an actual review pass, not just "no known issues."

**Scope.** The 17 files under `packages/contracts/src/` that are committed to git and part of the
shipped protocol (`DRIFTCore`, `DRIFTCoreStorage`, `DRIFTToken`, `DRIFTClientFactory`,
`WeightedGovernanceClient`, the `EASAdapter`, and their interfaces). Explicitly out of scope:
untracked work-in-progress files present in the working tree but never committed
(`src/policies/{EASPolicy,MeritProgressionPolicy,OpenPolicy,VouchingPolicy,ZKPolicy}.sol`,
`src/templates/base/`) — these are not part of the reviewed protocol.

**Method.** Slither 0.11.5, run via `nix develop` (reproducible — see `flake.nix`) against
`packages/contracts`, filtered to the scope above and excluding `lib/` dependencies:

```
slither packages/contracts --foundry-out-directory out \
  --filter-paths "lib/|src/policies/EASPolicy\.sol|src/policies/MeritProgressionPolicy\.sol|src/policies/OpenPolicy\.sol|src/policies/VouchingPolicy\.sol|src/policies/ZKPolicy\.sol|src/templates/base/" \
  --exclude-dependencies
```

Every finding below was independently checked against the actual code, not accepted at face
value. Four findings — three from manual review Slither cannot perform, one it flagged directly —
were real and have been fixed in this commit. Mythril was not run: it is not packaged in the
pinned nixpkgs revision (checked both `mythril` and `python3Packages.mythril`), and appears to
have been dropped upstream given its unmaintained dependency pins. Slither alone gives real
coverage for this codebase's risk profile (see B3 in `TODO.md` for the fuller reasoning).

Manual review covered every `external`/`public` function's access control, the UUPS storage
layout (`DRIFTCoreStorage`'s `__gap` bookkeeping), the AccessControl role hierarchy (which roles
administer which), ERC-1155 non-transferability enforcement, EIP-712/ERC-1271 settlement signature
verification, and the two developer-authored `// BUG:` / `// WARNING:` comments already present
in the code pointing at known-unresolved concerns.

All 129 contracts tests pass after the fixes below (`forge test`), `forge fmt --check` and
`forge lint` are clean.

---

## Fixed findings

### F1 — Cross-context admin takeover (High)

**Not caught by Slither** — an AccessControl configuration gap, not a code pattern a static
analyzer scans for. Found by manually tracing who administers what role.

`registerContext` is fully permissionless: anyone can call it and become that context's admin.
But `contextAdminRole(uid)`'s OpenZeppelin role-admin was never set via `_setRoleAdmin`, so it
defaulted to `DEFAULT_ADMIN_ROLE` — the *platform* admin, not the context's own admin. Verified
with a proof of concept: the platform admin could call
`grantRole(contextAdminRole(anyContext), attacker)` for a context registered by a completely
unrelated third party, with zero consent from that context's actual owner, handing over every
`onlyContextAdmin`-gated capability — including `setTrustedSettler` on a governance client, i.e.
redirecting settlement authority entirely.

This is a real gap in the formal contract's P3 (Context isolation) as stated: P3 as proved covers
*cryptographic* isolation (a proof valid for c₁ can't be replayed against c₂) but says nothing
about *administrative* isolation (control over c₁ can't be seized without c₁'s consent). Worth
flagging explicitly in the dissertation if P3 is going to be cited as "contexts are isolated" —
before this fix, administrative isolation didn't hold; after it, both dimensions do.

**Fix:** `registerContext` now calls `_setRoleAdmin(contextAdminRole(uid), contextAdminRole(uid))`
before granting it — the standard OpenZeppelin self-administering pattern. Contexts are now
sovereign: only existing members of a context's admin role can grant or revoke it. The platform's
`DEFAULT_ADMIN_ROLE` retains no implicit override.

**Regression test:** `test_RevertIf_PlatformAdminGrantsContextAdminRoleWithoutConsent`
(`test/unit/core/DRIFTCore.t.sol`) — asserts the platform admin's `grantRole` attempt now reverts,
and that the context's own admin can still manage the role themselves.

**Gas cost of the fix:** `registerContext` grew from 105,403 to 130,086 gas (+23.4%) — one
additional `AccessControl` role-admin `SSTORE`, paid once per context, ever.

### F2 — `deregisterNode` left reputation tokens unburned (Medium)

**Already self-flagged by the original developer** (`// BUG: what about the reputation tokens of
that user?`, `DRIFTCore.sol`), never resolved. Not a Slither-catchable pattern — a
data-lifecycle/completeness gap, not a code smell.

A node's ERC-1155 reputation balance survived `deregisterNode` untouched. This didn't allow
gaming a *future* claim in the same context — `claimReputation`'s reward/slash delta reconciles
balance to the settled score regardless of registration history — but it did mean `balanceOf`
was not a trustworthy "currently a member" signal: any external integration reading it directly
(rather than cross-checking `isRegistered`) could be misled by a stale non-zero balance for a
node that had already left.

**Fix:** `DRIFTCore` now tracks, per `(context, node)`, every role `reward()` has ever minted for
that node (`_nodeHasEarnedRole` for de-duplication, `_nodeEarnedRoles` for enumeration — ERC-1155
has no native per-holder token-ID enumeration, so this has to be tracked explicitly).
`deregisterNode` burns every non-zero balance across those roles and resets the tracking flags
(not just the array) so a later re-registration and re-earn of the same role is tracked correctly
for a *subsequent* deregistration too.

**Regression tests:** `test_DeregisterNodeBurnsHeldReputation` (multi-role burn),
`test_DeregisterThenReregisterAndReearn_TracksRoleAgain` (the reset-tracking edge case).

**Gas cost of the fix:** `reward()` grew materially on a node's *first* reward for a given role in
a context (one cold `SSTORE` + one array push) — visible in `Claim_Depth_10_Users_1024` moving
91,477 → 158,823 gas (+73.6%) in the isolated first-claim benchmark. Repeat rewards for an
already-tracked role (the common case — most nodes earn the same role across many epochs) pay
only one extra cold `SLOAD` to check the flag. `deregisterNode` itself now costs
O(distinct roles ever earned in that context) instead of O(1) — see the Residual Risk section
below for the bound on this.

**Update (post-audit):** `_nodeHasEarnedRole`/`_nodeEarnedRoles` were later replaced by a single
`EnumerableSet.Bytes32Set` (`_nodeRoles`) — same burn-on-deregister guarantee, one structure
instead of two kept in sync by hand. Separately, role membership stopped being an implicit
side-effect of `reward()` at all: `assignRole`/`revokeRole` are now the only way a node's role set
changes, and `reward()` requires the role already be held (`RoleNotHeld` otherwise). This closes a
related gap this audit didn't originally scope: previously a compromised settler proving an
inflated score for *any* role name could mint that role's governance weight as a side effect;
now minting requires a separately-authorized `assignRole` call first. The gas figures above and
the O(distinct roles) bound in Residual Risk item 1 still hold — `_nodeRoles` is enumerated and
cleared in `deregisterNode` exactly as `_nodeEarnedRoles` was — but the roles counted are now
"ever assigned," not "ever rewarded."

### F3 — `setContextClient` had no defense-in-depth against the calling factory's own bugs (Low)

**Already self-flagged by the original developer** (`// WARNING: shouldn't the factory be the
only one allowed to do this?`, `DRIFTCore.sol`), never resolved.

`setContextClient` was gated `onlyRole(FACTORY_ROLE)` alone, not per-context-admin — it relied
entirely on the calling factory contract having already verified the original caller against that
specific context's admin role. `DRIFTClientFactory.deployClient` does this correctly today, but
`DRIFTCore` itself had no independent check: any future or alternate contract granted
`FACTORY_ROLE` — including via a bug that omitted or mis-scoped the caller check — could rebind
*any* context's client to *any* address, no per-context authorization required.

**Fix:** `setContextClient` gained a third parameter, `caller` — the address that actually
requested the change (the factory's own `msg.sender`) — which `DRIFTCore` now independently
re-validates against `contextAdminRole(contextUID)` before proceeding.
`DRIFTClientFactory.deployClient` was updated to pass its own `msg.sender` through. This closes
the gap for factory *bugs*; it does not (and cannot) defend against a factory that is itself
malicious and deliberately lies about `caller` — a contract granted `FACTORY_ROLE` is a trusted
component by construction, and no amount of interface plumbing changes that. State this
explicitly as the trust boundary: **only grant `FACTORY_ROLE` to audited factory contracts.**

**Regression test:** `test_RevertIf_SetContextClientCallerIsNotContextAdmin`
(`test/unit/core/DRIFTCore.t.sol`) — a `FACTORY_ROLE` holder passing a `caller` who isn't that
context's admin is rejected regardless of holding the role itself.

### F4 — Inconsistent compiler pragma (Trivial)

Slither's `solc-version` detector flagged `IDRIFTToken.sol` for using a floating
`pragma solidity ^0.8.0` — the only file in the codebase not pinned to the exact `0.8.28` every
other file (and the actual test/deployment toolchain) uses. No logic in an interface file, so no
real risk, but inconsistent and easy to fix.

**Fix:** pinned to `pragma solidity 0.8.28;`, matching every other file. This also made the
`solc-version` detector category disappear entirely from the Slither run (it fires per-project on
any file using a range with known historical bugs, not per-file).

---

## Slither triage (full, post-fix)

Re-ran after the fixes above. 43 findings across 13 detector categories — up from 39 pre-fix,
entirely from the new logic in F2 (a bounded loop with external calls, discussed below); every
finding is accepted, a documented trust boundary, or cosmetic. None are exploitable beyond what's
already covered above.

| Detector | Count | Verdict |
|---|---|---|
| `arbitrary-send-eth` | 2 | Both in `WeightedGovernanceClient` (`respondToChallenge`, `withdrawSettlementBond`), sending to `trustedSettler` — a state-controlled, admin-set address, not attacker-controlled. Accepted. |
| `reentrancy-no-eth` | 2 | `registerNode` (pre-existing, calls an admin-configured `IPolicy` before writing `nodeStatus`) and `deregisterNode` (new, F2's burn loop calls `driftToken` before the final `delete`). Both call fixed, trusted, non-attacker-controlled contracts; a malicious `IPolicy` can only harm the context admin's own context. Accepted. |
| `reentrancy-benign` | 2 | Same two functions, lower-severity classification (Slither's own tiering) for a second state write after the same calls. Accepted. |
| `reentrancy-events` | 7 | Event emitted after an external call in `claimReputation`, `claimUnansweredChallenge`, `registerNode`, `deregisterNode` (new), `respondToChallenge`, `DRIFTCore.reward`, `DRIFTCore.slash`. Lowest Slither severity tier — only event *ordering*, not state risk. All underlying state is fully resolved via checks-effects-interactions before every one of these calls; the bond-transfer paths are additionally reentrancy-tested via `MockReentrantChallenger`. Accepted. |
| `calls-loop` | 2 | New in F2: `deregisterNode`'s burn loop calls `driftToken.balanceOf`/`slashReputation` per earned role. `driftToken` cannot trigger a reentrant callback here — OpenZeppelin ERC-1155's `_update` only invokes `onERC1155Received`/`BatchReceived` hooks when `to != address(0)`, and burns set `to = address(0)`. The real (non-security) concern is gas growth with the number of *distinct* roles a node has ever earned in a context — see Residual Risk. |
| `missing-zero-check` | 1 | `DRIFTClientFactory.deployClient`'s `clone` variable — false positive. `Clones.cloneDeterministic` reverts on deployment failure, so `clone` can never be the zero address by the time it's used. |
| `shadowing-local` | 2 | A `version` parameter name shadowing the unrelated `version()` metadata function in `getWeightAtVersion`/`getRolesAtVersion`. Cosmetic — Solidity resolves this lexically with no functional impact. |
| `timestamp` | 3 | Standard `block.timestamp` comparisons for attestation expiry and proposal deadlines, all at day/longer granularity — no meaningful miner-manipulation risk. Accepted, standard pattern. |
| `assembly` | 1 | `DRIFTClientFactory`'s revert-reason-bubbling assembly block — the standard, well-understood pattern for propagating a sub-call's exact revert data. |
| `costly-loop` | 1 | `setRoleWeights`'s `delete roleWeights[...]` in a loop, bounded by the existing `roles.length <= 10` (`MaximumRoleLengthExceeded`) check. Not a DoS vector. |
| `cyclomatic-complexity` | 2 | `postEpochRoot` and `castVoteWithProofs`, both complexity 12. A maintainability/auditability note (more branches to review), not a vulnerability by itself. |
| `low-level-calls` | 6 | All are the intentional bond-transfer `.call{value}("")` paths, the clone-init call, and `executeProposal`'s arbitrary target call — every one checks its `success`/`sent` return and reverts explicitly on failure. |
| `naming-convention` | 11 | Leading-underscore constructor/initializer parameters, `_contextPolicies`, `__gap`. Zero security relevance. |

**Slither found nothing exploitable in this codebase.** Its value here was almost entirely as a
checklist to confirm the *absence* of common patterns (unbounded external-call loops with real
reentrancy risk, unchecked low-level calls, floating pragmas) — the actual substantive findings
(F1-F3) came from manually tracing access control and token lifecycle, which is exactly what a
static analyzer is not built to do.

---

## Residual risk — what this audit does NOT rule out

For the dissertation's honest-limitations framing, not just the wins:

1. **`deregisterNode`'s gas cost scales with distinct roles ever earned, unboundedly.** If a
   context repeatedly reconfigures its active role set (`setRoleWeights`) over a long lifetime and
   one very active node earns reputation under many distinct roles across that history,
   `_nodeEarnedRoles` for that node grows without an upper bound, and so does the gas cost of
   *that node's own* `deregisterNode` call. This cannot lock out or harm any other node or the
   contract as a whole — it is entirely self-inflicted and self-limiting (only the caller pays,
   only for their own history) — but in a sufficiently degenerate case it could make deregistering
   prohibitively expensive or exceed the block gas limit for that one node. No fix applied: a real
   fix (pagination, a `maxRolesToBurn` parameter, or capping distinct roles per context) adds
   real complexity for a scenario with no cross-user impact. Worth a sentence in Limitations if F2
   is cited.

2. **`FACTORY_ROLE` and `DEFAULT_ADMIN_ROLE` remain fully trusted parties.** F1 removed the
   platform admin's *implicit* override of context administration, but `DEFAULT_ADMIN_ROLE` still
   authorizes UUPS upgrades (`_authorizeUpgrade`) and can grant `FACTORY_ROLE` to any contract —
   a malicious or compromised upgrade could still rewrite `DRIFTCore`'s logic arbitrarily, and a
   deliberately malicious contract granted `FACTORY_ROLE` can still lie about `caller` in
   `setContextClient` (F3 only defends against *buggy*, not *malicious*, factories). This is a
   standard, unavoidable property of any UUPS-upgradeable, factory-pattern system — not a defect,
   but it should be stated as an explicit trust assumption in the Trust Model section rather than
   left implicit.

3. **`IPolicy` contracts are fully trusted by the context admin that configures them.**
   `registerNode`'s external call to `IPolicy.evaluate()` happens before some state writes
   (flagged by Slither, triaged above as low-risk), and more broadly, a malicious policy contract
   controls admission outcomes entirely for its context. This is inherent to the pluggable-policy
   design (`setContextPolicy` is `onlyContextAdmin`-gated, so a context admin can only hurt their
   own context by choosing a bad policy) and not something to "fix," but worth stating precisely:
   the trust boundary is "the context admin vouches for their policy contract," not "policies are
   sandboxed."

4. **Two pre-existing design notes, not vulnerabilities, left as-is:**
   - `DRIFTCoreStorage.sol`: a context can only have one `IPolicy` at a time (no composition,
     e.g. "must pass an EAS check AND meet a minimum stake"). An extensibility limitation, not a
     security gap.
   - `IDRIFTGovernanceTokenWeighted.sol` (dead code — grep confirms zero usages anywhere in
     `src/` or `test/`): its own doc comment already correctly warns that live ERC-1155 balance
     reads are flash-loan-manipulable and restricts itself to "UI display... non-critical queries
     only." The actual shipped governance path (`castVoteWithProofs`) uses Merkle-proof-verified
     epoch snapshots instead of live balances, so this risk doesn't apply to any live code path —
     included here only because its presence in the tree might otherwise look like an unaddressed
     warning.

5. **This audit is Slither + manual review, not a full formal verification or a professional
   third-party audit.** It's appropriate evidence that "a systematic review pass was performed and
   its findings closed," not a claim that the contracts are proven free of vulnerabilities. Frame
   it that way in the dissertation.

---

## Reproducing this audit

```bash
cd packages/contracts
nix develop --command slither . --foundry-out-directory out \
  --filter-paths "lib/|src/policies/EASPolicy\.sol|src/policies/MeritProgressionPolicy\.sol|src/policies/OpenPolicy\.sol|src/policies/VouchingPolicy\.sol|src/policies/ZKPolicy\.sol|src/templates/base/" \
  --exclude-dependencies
forge test   # 129 tests, all green
forge fmt --check
forge lint
```
