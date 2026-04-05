## Roadmap

### DRIFT Iterations

- [ ] Simple Reputation System (Static parameters)

- [ ] Reputation System + Governance (Static parameters)

- [ ] Full system (dynamic dictionary of parameters, variable_name => value)

- [ ] Self-learning system (dynamic dictionary of parameters, variable_name => value, with parameter weight deduction)

    - [ ] Proportional-Integral-Derivative ?

### Smart Contracts

- [ ] ERC20 implementation (fungible-token)

- [ ] ERC5114 implementation (SBT)

### Parameter fine-tuning

- [ ] Time-lock for governance participation

- [ ] Correlated Slashing Multiplier: Fine-tuning the steepness of the penalty when multiple nodes fail simultaneously (defeats AWS/Sybil outages).

- [ ] The Trust Bootstrap Clamp: Fine-tuning the Lerp mapping (Smin to 0.40 / Smax to 0.70) based on live network Gini coefficients.

### Extras

- [ ] Delegated staking?

- [ ] Exponential cooldown for repeat offenders

- [ ] Challenge window for proposals

- [ ] Gini coefficient for real-time parameter tuning

- [ ] Commit-Reveal / Honeypot Tasks: As an oracle, you must include a defense against nodes just copying the answers of other nodes from the public mempool.
