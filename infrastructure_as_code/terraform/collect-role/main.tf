# Default assume role trust policy
# Allows the IAM Collect role in the collect account to assume the role
data "aws_iam_policy_document" "default_assume_role_policy" {
  statement {
    actions = [
      "sts:AssumeRole"
    ]
    principals {
      type = "AWS"
      identifiers = [
        "*"
      ]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:PrincipalArn"
      values = [
        "arn:${data.aws_partition.current.partition}:iam::${var.central_collect_account_id}:role${var.role_path}${var.role_name}"
      ]
    }
  }

  # If you are deploying the role in the central collect account, trust identity policies in that same account.
  dynamic "statement" {
    for_each = data.aws_caller_identity.current.account_id == var.central_collect_account_id ? [1] : []
    content {
      actions = [
        "sts:AssumeRole"
      ]
      principals {
        type = "AWS"
        identifiers = [
          "arn:${data.aws_partition.current.partition}:iam::${var.central_collect_account_id}:root"
        ]
      }
    }
  }
}

resource "aws_iam_role" "collect_role" {
  name               = var.role_name
  path               = var.role_path
  description        = var.description
  assume_role_policy = var.assume_role_policy != null ? var.assume_role_policy : data.aws_iam_policy_document.default_assume_role_policy.json

  tags = var.tags
}


data "aws_iam_policy_document" "collect_policy" {
  statement {
    sid = "CollectIAMData"

    actions = [
      "account:ListRegions",
      "apigateway:GET",
      "backup:GetBackupVaultAccessPolicy",
      "backup:ListBackupVaults",
      "backup:ListTags",
      "codebuild:BatchGetProjects",
      "codebuild:GetResourcePolicy",
      "codebuild:ListProjects",
      "dynamodb:GetResourcePolicy",
      "dynamodb:ListStreams",
      "dynamodb:ListTables",
      "dynamodb:ListTagsOfResource",
      "ec2:DescribeVpcEndpoints",
      "ecr:DescribeRepositories",
      "ecr:GetRegistryPolicy",
      "ecr:GetRepositoryPolicy",
      "ecr:ListTagsForResource",
      "eks:DescribeAccessEntry",
      "eks:DescribeCluster",
      "eks:ListAccessEntries",
      "eks:ListAssociatedAccessPolicies",
      "eks:ListClusters",
      "elasticfilesystem:DescribeFileSystemPolicy",
      "elasticfilesystem:DescribeFileSystems",
      "elasticfilesystem:ListTagsForResource",
      "es:DescribeDomain",
      "es:ListDomainNames",
      "es:ListTags",
      "events:DescribeEventBus",
      "events:ListEventBuses",
      "events:ListTagsForResource",
      "glacier:GetVaultAccessPolicy",
      "glacier:ListTagsForVault",
      "glacier:ListVaults",
      "glue:GetResourcePolicy",
      "iam:GetAccountAuthorizationDetails",
      "iam:GetOpenIDConnectProvider",
      "iam:GetSAMLProvider",
      "iam:ListInstanceProfiles",
      "iam:ListOpenIDConnectProviderTags",
      "iam:ListOpenIDConnectProviders",
      "iam:ListPolicyTags",
      "iam:ListSAMLProviderTags",
      "iam:ListSAMLProviders",
      "kafka:DescribeCluster",
      "kafka:GetClusterPolicy",
      "kafka:ListClustersV2",
      "kafka:ListTagsForResource",
      "kinesis:DescribeStream",
      "kinesis:GetResourcePolicy",
      "kinesis:ListStreams",
      "kinesis:ListTagsForStream",
      "kms:GetKeyPolicy",
      "kms:ListKeys",
      "kms:ListResourceTags",
      "lambda:GetLayerVersionPolicy",
      "lambda:GetPolicy",
      "lambda:ListFunctions",
      "lambda:ListLayerVersions",
      "lambda:ListLayers",
      "lambda:ListTags",
      "organizations:DescribeOrganization",
      "organizations:DescribePolicy",
      "organizations:DescribeResourcePolicy",
      "organizations:ListAccountsForParent",
      "organizations:ListDelegatedAdministrators",
      "organizations:ListDelegatedServicesForAccount",
      "organizations:ListOrganizationalUnitsForParent",
      "organizations:ListPolicies",
      "organizations:ListPoliciesForTarget",
      "organizations:ListRoots",
      "organizations:ListTagsForResource",
      "ram:GetResourcePolicies",
      "ram:ListResources",
      "s3-outposts:GetAccessPointPolicy",
      "s3-outposts:GetBucketPolicy",
      "s3-outposts:GetBucketTagging",
      "s3-outposts:ListAccessPoints",
      "s3-outposts:ListOutpostsWithS3",
      "s3-outposts:ListRegionalBuckets",
      "s3:GetAccessPoint",
      "s3:GetAccessPointForObjectLambda",
      "s3:GetAccessPointPolicy",
      "s3:GetAccessPointPolicyForObjectLambda",
      "s3:GetAccountPublicAccessBlock",
      "s3:GetBucketAbac",
      "s3:GetBucketPolicy",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketTagging",
      "s3:GetEncryptionConfiguration",
      "s3:GetMultiRegionAccessPointPolicy",
      "s3:ListAccessPoints",
      "s3:ListAccessPointsForObjectLambda",
      "s3:ListAllMyBuckets",
      "s3:ListMultiRegionAccessPoints",
      "s3:ListTagsForResource",
      "s3express:GetAccessPoint",
      "s3express:GetAccessPointPolicy",
      "s3express:GetBucketPolicy",
      "s3express:GetEncryptionConfiguration",
      "s3express:ListAccessPointsForDirectoryBuckets",
      "s3express:ListAllMyDirectoryBuckets",
      "s3express:ListTagsForResource",
      "s3tables:GetTableBucketEncryption",
      "s3tables:GetTableBucketPolicy",
      "s3tables:ListTableBuckets",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:ListSecrets",
      "sns:GetTopicAttributes",
      "sns:ListTagsForResource",
      "sns:ListTopics",
      "sqs:GetQueueAttributes",
      "sqs:ListQueueTags",
      "sqs:ListQueues",
      "sso:DescribePermissionSet",
      "sso:GetInlinePolicyForPermissionSet",
      "sso:GetPermissionsBoundaryForPermissionSet",
      "sso:ListAccountsForProvisionedPermissionSet",
      "sso:ListCustomerManagedPolicyReferencesInPermissionSet",
      "sso:ListInstances",
      "sso:ListManagedPoliciesInPermissionSet",
      "sso:ListPermissionSets",
      "sso:ListTagsForResource"
    ]
    resources = [
      "*"
    ]
  }
}

resource "aws_iam_role_policy" "collect_data_policy" {
  name   = "iam-collect-policy"
  role   = aws_iam_role.collect_role.id
  policy = data.aws_iam_policy_document.collect_policy.json
}

data "aws_iam_policy_document" "assume_collect_role_policy" {
  statement {
    sid = "AssumeCollectRole"

    actions = [
      "sts:AssumeRole"
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::*:role${var.role_path}${var.role_name}"
    ]
  }
}

resource "aws_iam_role_policy" "assume_collect_role_policy" {
  count  = data.aws_caller_identity.current.account_id == var.central_collect_account_id ? 1 : 0
  name   = "assume-collect-role-policy"
  role   = aws_iam_role.collect_role.id
  policy = data.aws_iam_policy_document.assume_collect_role_policy.json
}
