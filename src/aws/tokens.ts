import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { type AwsCredentialIdentity } from '@aws-sdk/types'

/**
 * Get the AWS account ID and partition from the provided credentials.
 *
 * @param credentials The AWS credentials to use for the request.
 * @returns An object containing the AWS account ID and partition for the provided credentials.
 */
export async function getTokenInfo(credentials: AwsCredentialIdentity): Promise<{
  accountId: string
  partition: string
  arn: string
}> {
  const stsClient = new STSClient({ credentials })
  const command = new GetCallerIdentityCommand({})
  try {
    const response = await stsClient.send(command)
    const accountId = response.Account
    const arn = response.Arn
    const arnParts = arn!.split(':')
    const partition = arnParts[1]
    return {
      accountId: accountId!,
      partition: partition,
      arn: arn!
    }
  } finally {
    stsClient.destroy()
  }
}
