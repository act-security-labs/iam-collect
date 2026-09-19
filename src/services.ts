/**
 * All Valid AWS Services
 */
export const allServices = [
  'apigateway',
  'backup',
  'codeartifact',
  'dynamodb',
  'ec2',
  'ecr',
  'eks',
  'elasticfilesystem',
  'es',
  'events',
  'glacier',
  'glue',
  'iam',
  'kafka',
  'kinesis',
  'kms',
  'lambda',
  'organizations',
  'ram',
  's3',
  's3-object-lambda',
  's3express',
  's3outposts',
  's3tables',
  'secretsmanager',
  'sns',
  'sqs',
  'sso'
] as const

/**
 * Type representing a valid AWS service. A union of all strings in `allServices`.
 */
export type AwsService = (typeof allServices)[number]

/**
 * Convert a service name to lowercase.
 *
 * @param service The service name to convert
 * @returns The lowercase service name
 */
export function lowerCaseService(service: string): AwsService {
  return service.toLowerCase() as AwsService
}
