# KMS AWS-Managed Key Metadata Plan

## Feature Brief

- **Problem statement:** Collected KMS key metadata does not identify AWS-managed keys, so consumers cannot distinguish them from customer-managed keys.
- **Goals:** Persist `metadata.awsManaged: true` for AWS-managed KMS keys only; omit the property for customer-managed or unknown keys. Support both native AWS APIs and AWS Config. Update collector permissions and supported-data documentation.
- **Non-goals:** Collecting other KMS key attributes, emitting `awsManaged: false`, or changing metadata for non-KMS resources.
- **Target package/API:** `kms` key resource metadata produced by `@actsecurity/iam-collect`.
- **User-facing behavior:** AWS-managed KMS keys contain `{ arn, id, awsManaged: true }` metadata. Customer-managed keys contain `{ arn, id }`.
- **Inputs:** Native KMS `DescribeKey` response `KeyMetadata.KeyManager`; AWS Config `AWS::KMS::Key` `configuration.keyManager`.
- **Outputs:** Additive, sparse `awsManaged` boolean in existing KMS metadata.
- **Errors/diagnostics:** Existing typed-sync access-denied logging makes the field undefined without failing the key; existing local 404 handling does the same. Missing AWS Config data also omits the field.
- **Compatibility concerns:** Additive metadata only; no migration. A later sync naturally removes the property if the source no longer reports it as AWS-managed.
- **Documentation impact:** Root supported-data table and AWS Config support documentation.

## Implementation Plan

1. Update `src/syncs/kms/key.ts`.
   - Add a `DescribeKeyCommand` extra field for each listed key.
   - Use `KeyMetadata.KeyManager === 'AWS'` to conditionally add `awsManaged: true` to metadata.
   - Retain existing id, ARN, tags, and policy behavior.

2. Update `src/awsConfigClients/clients/AwsConfigKmsClient.ts`.
   - Register a Config-backed `DescribeKeyCommand`.
   - Select and parse `configuration.keyManager` from `AWS::KMS::Key` results.
   - Cache the manager with the existing policy and tags, and return it as `KeyMetadata.KeyManager`.
   - Return no manager when Config does not supply it.

3. Update permission examples.
   - Add `kms:DescribeKey` to `src/aws/collect-policy.json`.
   - Add `kms:DescribeKey` to `infrastructure_as_code/terraform/collect-role/main.tf`.

4. Add tests.
   - Add native KMS sync coverage that verifies true is persisted for an AWS-managed key, absent for a customer-managed key, and DescribeKey calls use each key ID.
   - Add AWS Config KMS coverage for `configuration.keyManager` and missing-manager behavior.

5. Update documentation.
   - Add AWS-managed classification to the KMS Keys row in `README.md`.
   - State in `docs/AwsConfig.md` that KMS AWS-managed classification is available through Config.

## Test Strategy

- Use synthetic KMS ARNs/IDs and Vitest AWS SDK mocks.
- Assert complete meaningful metadata objects, not only metadata existence.
- Cover AWS-managed, customer-managed, and missing Config manager cases.
- Run focused tests, then `npm run build`, `npm test`, and `npm run format-check`.

## Risks and Alternatives

- `DescribeKey` adds one per-key API request; existing worker-pool concurrency and access-denied handling apply.
- Do not infer management from aliases or ARNs because `KeyManager` is authoritative.
- Do not store `false`, per the requested sparse output contract.

## Pre-Implementation Confidence Gate

- [x] Discovery findings recorded
- [x] Product behavior is explicit
- [x] Inputs are final enough to implement
- [x] Outputs are final enough to implement
- [x] Exported types/APIs are final enough to implement
- [x] Error/diagnostic behavior is explicit
- [x] Test strategy is explicit
- [x] Docs/examples impact is explicit
- [x] Backwards compatibility impact is explicit
- [x] Claude plan review concerns resolved
- [x] Codex/current-model plan review concerns resolved
- [ ] User approved implementation
