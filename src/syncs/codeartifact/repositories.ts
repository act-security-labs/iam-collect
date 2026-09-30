import {
  CodeartifactClient,
  GetRepositoryPermissionsPolicyCommand,
  ListRepositoriesCommand,
  ListTagsForResourceCommand
} from '@aws-sdk/client-codeartifact'
import { runAndCatchError } from '../../utils/client-tools.js'
import { parseIfPresent } from '../../utils/json.js'
import { createResourceSyncType, createTypedSyncOperation } from '../typedSync.js'

export const CodeArtifactRepositoriesSync = createTypedSyncOperation(
  'codeartifact',
  'repositories',
  createResourceSyncType({
    client: CodeartifactClient,
    command: ListRepositoriesCommand,
    key: 'repositories',
    paginationConfig: {
      inputKey: 'nextToken',
      outputKey: 'nextToken'
    },
    arn: (repository) => repository.arn!,
    extraFields: {
      tags: async (client, repository) => {
        const result = await client.send(
          new ListTagsForResourceCommand({ resourceArn: repository.arn })
        )
        return result.tags
      },
      policy: async (client, repository) => {
        return runAndCatchError('ResourceNotFoundException', async () => {
          const result = await client.send(
            new GetRepositoryPermissionsPolicyCommand({
              domain: repository.domainName!,
              domainOwner: repository.domainOwner,
              repository: repository.name!
            })
          )
          return parseIfPresent(result.policy?.document)
        })
      }
    },
    tags: (repository) => repository.extraFields.tags,
    resourceTypeParts: (account, region) => ({
      service: 'codeartifact',
      resourceType: 'repository',
      account,
      region
    }),
    results: (repository) => ({
      metadata: {
        name: repository.name,
        domainName: repository.domainName,
        domainOwner: repository.domainOwner,
        administratorAccount: repository.administratorAccount,
        description: repository.description
      },
      policy: repository.extraFields.policy
    })
  })
)
