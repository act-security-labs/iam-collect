import { type AwsService, lowerCaseService } from '../services.js'
import { RestApisSync } from './apigateway/gateways.js'
import { BackupVaultsSync } from './backup/backupVaults.js'
import { DynamoDbStreamsSync } from './dynamodb/dynamoDbStreams.js'
import { DynamoDBTableSync } from './dynamodb/tables.js'
import { VpcEndpointsSync } from './ec2/vpcEndpoints.js'
import { EcrSyncs } from './ecr/ecrSyncs.js'
import { ElasticFileSystemsSync } from './efs/fileSystems.js'
import { EksAccessEntriesSync } from './eks/accessEntries.js'
import { EventBridgeEventBusesSync } from './events/eventBuses.js'
import { GlueCatalogSync } from './glue/catalogs.js'
import { AuthorizationDetailsSync } from './iam/authorizationDetails.js'
import { IdentityProviderSyncs } from './iam/identityProviders.js'
import { InstanceProfilesSync } from './iam/instanceProfiles.js'
import { KafkaClustersSync } from './kafka/clusters.js'
import { KinesisDataStreamsSync } from './kinesis/dataStreams.js'
import { KeySync } from './kms/key.js'
import { LambdaLayerVersionsSync, LambdaSync } from './lambda/lambda.js'
import { OpenSearchDomainsSync } from './opensearch/domains.js'
import { OrganizationSync } from './organizations/organizations.js'
import { RamResourcesSync } from './ram/ramShares.js'
import { S3AccessPointsSync } from './s3/accessPoints.js'
import { AccountS3BpaSync } from './s3/accountBpa.js'
import { S3GeneralPurposeBucketSync } from './s3/buckets.js'
import { S3MultiRegionAccessPointsSync } from './s3/multiRegionAccessPoints.js'
import { S3ObjectLambdaAccessPointsSync } from './s3/objectLambdaAccessPoints.js'
import { GlacierVaultsSync } from './s3/vaults.js'
import { S3DirectoryAccessPointsSync } from './s3express/s3DirectoryAccessPointsSync.js'
import { S3DirectoryBucketsSync } from './s3express/s3DirectoryBucketsSync.js'
import { S3OutpostsAccessPointsSync, S3OutpostsBucketsSync } from './s3outposts/s3OutpostsSyncs.js'
import { S3TableBucketsSync } from './s3tables/s3TablesSync.js'
import { SecretSync } from './secretsmanager/secrets.js'
import { SesIdentitiesSync } from './ses/identities.js'
import { SnsTopicsSync } from './sns/topics.js'
import { SqsQueueSync } from './sqs/queues.js'
import { SsoDataSync } from './sso/ssoInstances.js'
import { type Sync } from './sync.js'

const allSyncs = [
  AccountS3BpaSync,
  AuthorizationDetailsSync,
  BackupVaultsSync,
  DynamoDbStreamsSync,
  DynamoDBTableSync,
  ...EcrSyncs,
  EksAccessEntriesSync,
  ElasticFileSystemsSync,
  EventBridgeEventBusesSync,
  InstanceProfilesSync,
  ...IdentityProviderSyncs,
  GlacierVaultsSync,
  GlueCatalogSync,
  KafkaClustersSync,
  KinesisDataStreamsSync,
  KeySync,
  LambdaSync,
  LambdaLayerVersionsSync,
  OpenSearchDomainsSync,
  OrganizationSync,
  RamResourcesSync,
  RestApisSync,
  S3AccessPointsSync,
  S3DirectoryBucketsSync,
  S3DirectoryAccessPointsSync,
  S3GeneralPurposeBucketSync,
  S3MultiRegionAccessPointsSync,
  S3ObjectLambdaAccessPointsSync,
  S3OutpostsAccessPointsSync,
  S3OutpostsBucketsSync,
  S3TableBucketsSync,
  SecretSync,
  SesIdentitiesSync,
  SnsTopicsSync,
  SqsQueueSync,
  SsoDataSync,
  VpcEndpointsSync
]

const syncMap = new Map<AwsService, { regional: Sync[]; global: Sync[] }>()

for (const sync of allSyncs) {
  const service = lowerCaseService(sync.awsService)
  if (!syncMap.has(service)) {
    syncMap.set(service, {
      regional: [],
      global: []
    })
  }
  const syncs = syncMap.get(service)!
  if (sync.global) {
    syncs.global.push(sync)
  } else {
    syncs.regional.push(sync)
  }
}

/**
 * Get the global syncs for a given AWS service.
 *
 * @param service The AWS service to get the syncs for
 * @returns An array of syncs that are global for the specified service.
 */
export function getGlobalSyncsForService(service: AwsService): Sync[] {
  const syncs = syncMap.get(lowerCaseService(service))
  if (!syncs) {
    return []
  }
  return syncs.global
}

/**
 * Get the regional syncs for a given AWS service.
 *
 * @param service The AWS service to get the syncs for
 * @returns An array of syncs that are regional for the specified service.
 */
export function getRegionalSyncsForService(service: AwsService): Sync[] {
  const syncs = syncMap.get(lowerCaseService(service))
  if (!syncs) {
    return []
  }
  return syncs.regional
}
