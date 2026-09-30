import {
  type FunctionConfiguration,
  GetLayerVersionPolicyCommand,
  GetPolicyCommand,
  LambdaClient,
  ListAliasesCommand,
  ListFunctionsCommand,
  ListLayersCommand,
  ListLayerVersionsCommand,
  ListTagsCommand
} from '@aws-sdk/client-lambda'
import { type Job } from '@actsecurity/job'
import { log } from '@actsecurity/log'
import {
  runAndCatch404,
  runAndCatchAccessDeniedWithLog,
  withDnsRetry
} from '../../utils/client-tools.js'
import { parseIfPresent } from '../../utils/json.js'
import { convertTagsToRecord } from '../../utils/tags.js'
import { type DataRecord, type Sync, syncData } from '../sync.js'
import { createResourceSyncType, paginateResource, paginateResourceConfig } from '../typedSync.js'

const lambdaFunctionSync = createResourceSyncType({
  client: LambdaClient,
  command: ListFunctionsCommand,
  key: 'Functions',
  paginationConfig: {
    inputKey: 'Marker',
    outputKey: 'NextMarker'
  },
  resourceTypeParts: (accountId: string, region: string) => ({
    service: 'lambda',
    resourceType: 'function',
    account: accountId,
    region: region
  }),
  extraFields: {
    tags: async (client, resource) => {
      return runAndCatch404(async () => {
        const tagResult = await client.send(new ListTagsCommand({ Resource: resource.FunctionArn }))
        return tagResult.Tags
      })
    },
    policy: async (client, resource) => {
      return runAndCatch404(async () => {
        const policyResult = await client.send(
          new GetPolicyCommand({ FunctionName: resource.FunctionName })
        )
        return parseIfPresent(policyResult.Policy)
      })
    }
  },
  tags: (func) => func.extraFields.tags,
  arn: (func) => func.FunctionArn!,
  results: (func) => ({
    metadata: {
      role: func.Role,
      name: func.FunctionName
    },
    policy: func.extraFields.policy
  })
})

export const LambdaSync: Sync = {
  awsService: 'lambda',
  name: 'lambdaFunctions',
  execute: async (accountId, region, credentials, storage, endpoint, syncOptions) => {
    const functions = await paginateResourceConfig(
      lambdaFunctionSync,
      credentials,
      region,
      endpoint,
      syncOptions.workerPool,
      'lambda',
      'lambdaFunctions',
      syncOptions.clientPool
    )

    const records: DataRecord[] = functions.map((func) => {
      const result = lambdaFunctionSync.results(func) as DataRecord
      result.arn = lambdaFunctionSync.arn(
        func,
        region,
        credentials.accountId,
        credentials.partition
      )
      result.metadata.arn = result.arn
      result.tags = convertTagsToRecord(lambdaFunctionSync.tags(func))
      return result
    })

    const lambdaClient = syncOptions.clientPool.client(LambdaClient, credentials, region, endpoint)
    const aliasJobs: Job<DataRecord[], { function: FunctionConfiguration }>[] = functions.map(
      (func) => ({
        properties: { function: func },
        execute: async () => collectAliasRecords(lambdaClient, func)
      })
    )
    const aliasResults = await Promise.all(syncOptions.workerPool.enqueueAll(aliasJobs))
    for (const result of aliasResults) {
      if (result.status === 'rejected') {
        const func = result.properties.function as FunctionConfiguration
        log.error('Failed to collect Lambda function aliases', result.reason, {
          functionArn: func.FunctionArn
        })
        throw new Error(`Failed to collect aliases for Lambda function ${func.FunctionArn}`)
      }
      records.push(...result.value)
    }

    await syncData(
      records,
      storage,
      accountId,
      lambdaFunctionSync.resourceTypeParts(credentials.accountId, region),
      syncOptions.writeOnly
    )
  }
}

async function collectAliasRecords(
  lambdaClient: LambdaClient,
  func: FunctionConfiguration
): Promise<DataRecord[]> {
  const aliases = await withDnsRetry(() =>
    paginateResource(
      lambdaClient,
      ListAliasesCommand,
      'Aliases',
      {
        inputKey: 'Marker',
        outputKey: 'NextMarker'
      },
      { FunctionName: func.FunctionName }
    )
  )

  const records: DataRecord[] = []
  for (const alias of aliases) {
    const policy = await withDnsRetry(() =>
      runAndCatchAccessDeniedWithLog(alias.AliasArn!, 'lambda', 'lambdaFunctions', 'policy', () =>
        runAndCatch404(async () => {
          const policyResult = await lambdaClient.send(
            new GetPolicyCommand({
              FunctionName: func.FunctionName,
              Qualifier: alias.Name
            })
          )
          return parseIfPresent(policyResult.Policy)
        })
      )
    )

    records.push({
      arn: alias.AliasArn!,
      metadata: {
        arn: alias.AliasArn,
        role: func.Role,
        name: func.FunctionName,
        isAlias: 'true',
        alias: alias.Name,
        version: alias.FunctionVersion
      },
      policy
    })
  }
  return records
}

export const LambdaLayerVersionsSync: Sync = {
  awsService: 'lambda',
  name: 'lambdaLayerVersions',
  execute: async (accountId, region, credentials, storage, endpoint, syncOptions) => {
    const lambdaClient = syncOptions.clientPool.client(LambdaClient, credentials, region, endpoint)
    const allLayers = await paginateResource(lambdaClient, ListLayersCommand, 'Layers', {
      inputKey: 'Marker',
      outputKey: 'NextMarker'
    })

    const allLayerVersions: DataRecord[] = []
    for (const layer of allLayers) {
      const layerVersions = await paginateResource(
        lambdaClient,
        ListLayerVersionsCommand,
        'LayerVersions',
        {
          inputKey: 'Marker',
          outputKey: 'NextMarker'
        },
        {
          LayerName: layer.LayerName
        }
      )

      for (const version of layerVersions) {
        const policy = await runAndCatchAccessDeniedWithLog(
          layer.LayerArn!,
          'lambda',
          'lambdaLayerVersion',
          'policy',
          async () => {
            return runAndCatch404(async () => {
              const policyResult = await lambdaClient.send(
                new GetLayerVersionPolicyCommand({
                  LayerName: layer.LayerName!,
                  VersionNumber: version.Version
                })
              )
              return parseIfPresent(policyResult.Policy)
            })
          }
        )

        allLayerVersions.push({
          arn: version.LayerVersionArn!,
          metadata: {
            name: layer.LayerName,
            version: version.Version
          },
          policy: policy
        })
      }
    }

    await syncData(
      allLayerVersions,
      storage,
      accountId,
      {
        service: 'lambda',
        resourceType: 'layer',
        account: accountId,
        region: region
      },
      syncOptions.writeOnly
    )
  }
}
