import {
  GetPolicyCommand,
  IoTClient,
  ListPoliciesCommand,
  ListTargetsForPolicyCommand
} from '@aws-sdk/client-iot'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { AwsClientPool } from '../../aws/ClientPool.js'
import { type AwsCredentialProviderWithMetaData } from '../../aws/coreAuth.js'
import { createInMemoryStorageClient } from '../../persistence/util.js'
import { IotPoliciesSync } from './policies.js'

const iotMock = mockClient(IoTClient)
const accountId = '111111111111'
const region = 'us-east-1'
const policyArn = `arn:aws:iot:${region}:${accountId}:policy/connected-devices`
const detachedPolicyArn = `arn:aws:iot:${region}:${accountId}:policy/detached-devices`
const credentials: AwsCredentialProviderWithMetaData = {
  accountId,
  partition: 'aws',
  cacheKey: 'test-credentials',
  provider: async () => ({
    accessKeyId: 'test-access-key-id',
    secretAccessKey: 'test-secret-access-key'
  })
}

const workerPool = {
  enqueueAll: (jobs: any[]) =>
    jobs.map(async (job) => {
      try {
        return {
          status: 'fulfilled',
          value: await job.execute({ workerId: 1, properties: job.properties }),
          properties: job.properties
        }
      } catch (reason) {
        return { status: 'rejected', reason, properties: job.properties }
      }
    })
} as any

describe('IotPoliciesSync', () => {
  afterEach(() => {
    iotMock.reset()
  })

  it('collects policy details, default documents, and all attached targets', async () => {
    //Given policies and targets returned across multiple pages
    const store = createInMemoryStorageClient()
    const stalePolicyArn = `arn:aws:iot:${region}:${accountId}:policy/stale-policy`
    await store.saveResourceMetadata(accountId, stalePolicyArn, 'metadata', {
      arn: stalePolicyArn,
      name: 'stale-policy'
    })
    await store.saveResourceMetadata(accountId, detachedPolicyArn, 'targets', [
      `arn:aws:iot:${region}:${accountId}:cert/previous-target`
    ])

    iotMock.on(ListPoliciesCommand).callsFake((input) => {
      if (input.marker === 'policy-page-2') {
        return {
          policies: [{ policyName: 'detached-devices', policyArn: detachedPolicyArn }]
        }
      }
      return {
        policies: [{ policyName: 'connected-devices', policyArn }],
        nextMarker: 'policy-page-2'
      }
    })
    iotMock.on(GetPolicyCommand).callsFake((input) => ({
      policyName: input.policyName,
      policyArn: input.policyName === 'connected-devices' ? policyArn : detachedPolicyArn,
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 'iot:Connect', Resource: '*' }]
      }),
      defaultVersionId: input.policyName === 'connected-devices' ? '3' : '1',
      generationId: `${input.policyName}-generation`,
      creationDate: new Date('2026-01-02T03:04:05.000Z'),
      lastModifiedDate: new Date('2026-02-03T04:05:06.000Z')
    }))
    iotMock.on(ListTargetsForPolicyCommand).callsFake((input) => {
      if (input.policyName === 'detached-devices') {
        return { targets: [] }
      }
      if (input.marker === 'target-page-2') {
        return {
          targets: [`arn:aws:iot:${region}:${accountId}:thinggroup/production-devices`]
        }
      }
      return {
        targets: [`arn:aws:iot:${region}:${accountId}:cert/certificate-id`],
        nextMarker: 'target-page-2'
      }
    })

    //When the IoT policy sync runs
    const clientPool = new AwsClientPool()
    await IotPoliciesSync.execute(accountId, region, credentials, store, undefined, {
      clientPool,
      workerPool,
      writeOnly: false
    })
    clientPool.clear()

    //Then policy metadata and the parsed default document are stored under the policy ARN
    await expect(store.getResourceMetadata(accountId, policyArn, 'metadata')).resolves.toEqual({
      arn: policyArn,
      name: 'connected-devices',
      defaultVersionId: '3',
      generationId: 'connected-devices-generation',
      creationDate: '2026-01-02T03:04:05.000Z',
      lastModifiedDate: '2026-02-03T04:05:06.000Z'
    })
    await expect(
      store.getResourceMetadata(accountId, policyArn, 'current-policy')
    ).resolves.toEqual({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'iot:Connect', Resource: '*' }]
    })

    //And every target is stored while detached targets and stale policies are removed
    await expect(store.getResourceMetadata(accountId, policyArn, 'targets')).resolves.toEqual([
      `arn:aws:iot:${region}:${accountId}:cert/certificate-id`,
      `arn:aws:iot:${region}:${accountId}:thinggroup/production-devices`
    ])
    await expect(
      store.getResourceMetadata(accountId, detachedPolicyArn, 'targets')
    ).resolves.toBeUndefined()
    await expect(store.listResourceMetadata(accountId, stalePolicyArn)).resolves.toEqual([])

    //And policy and target pagination use the markers returned by AWS
    expect(iotMock.commandCalls(ListPoliciesCommand).map((call) => call.args[0].input)).toEqual([
      { marker: undefined },
      { marker: 'policy-page-2' }
    ])
    expect(
      iotMock
        .commandCalls(ListTargetsForPolicyCommand)
        .filter((call) => call.args[0].input.policyName === 'connected-devices')
        .map((call) => call.args[0].input)
    ).toEqual([
      { policyName: 'connected-devices', marker: undefined },
      { policyName: 'connected-devices', marker: 'target-page-2' }
    ])
  })
})
