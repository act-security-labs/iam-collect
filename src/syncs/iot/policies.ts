import {
  GetPolicyCommand,
  IoTClient,
  ListPoliciesCommand,
  ListTargetsForPolicyCommand
} from '@aws-sdk/client-iot'
import { runAndCatch404 } from '../../utils/client-tools.js'
import { parseIfPresent } from '../../utils/json.js'
import { createResourceSyncType, createTypedSyncOperation, paginateResource } from '../typedSync.js'

const paginationConfig = {
  inputKey: 'marker',
  outputKey: 'nextMarker'
} as const

/**
 * Sync AWS IoT policies, their default policy documents, and attached targets.
 */
export const IotPoliciesSync = createTypedSyncOperation(
  'iot',
  'policies',
  createResourceSyncType({
    client: IoTClient,
    command: ListPoliciesCommand,
    key: 'policies',
    paginationConfig,
    arn: (policy) => policy.policyArn!,
    extraFields: {
      details: async (client, policy) => {
        return runAndCatch404(() =>
          client.send(new GetPolicyCommand({ policyName: policy.policyName! }))
        )
      },
      targets: async (client, policy) => {
        return runAndCatch404(() =>
          paginateResource(client, ListTargetsForPolicyCommand, 'targets', paginationConfig, {
            policyName: policy.policyName!
          })
        )
      }
    },
    tags: () => undefined,
    resourceTypeParts: (accountId, region) => ({
      service: 'iot',
      resourceType: 'policy',
      account: accountId,
      region
    }),
    results: (policy) => ({
      metadata: {
        name: policy.extraFields.details?.policyName ?? policy.policyName,
        defaultVersionId: policy.extraFields.details?.defaultVersionId,
        generationId: policy.extraFields.details?.generationId,
        creationDate: policy.extraFields.details?.creationDate,
        lastModifiedDate: policy.extraFields.details?.lastModifiedDate
      },
      'current-policy': parseIfPresent(policy.extraFields.details?.policyDocument),
      targets: policy.extraFields.targets
    })
  })
)
